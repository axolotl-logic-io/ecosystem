// The claim op: races other lanes for an issue (see raceForClaim) and, when
// this lane wins, leases the issue to it with the state it carries on from
// (claim-state.ts), readies its checkouts and saves the state. Its reply
// carries the issue and comments it read and the issue file it wrote from
// them, so the job's trusted-inputs revision is exactly what it was shown.
// A done issue is claimed only to reconcile its completion: its state stays
// done, and nothing is labelled, reset or set up.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureClone, ensureWorktree, setUpCheckout } from "../checkouts.ts";
import { laneOf, raceForClaim } from "../claims.ts";
import type { IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { fetchIn } from "../git-state.ts";
import { gh, issueState } from "../github.ts";
import type { Issue, IssueContext } from "../issue-context.ts";
import { trustedInputsHash, writeIssueContext } from "../issue-context.ts";
import { clearStopLabels, LABELS, setLabels } from "../labels.ts";
import { pruneLaneResources, withCheckoutSlot } from "../lane-slots.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import { readClaimState, writeState } from "../saved-state.ts";
import { STAGES } from "../stages.ts";
import type { IssueState } from "../state.ts";
import { withLog } from "../state.ts";
import { isStopLabel } from "../stops.ts";
import { resetKeepingUnpushed } from "../unpushed.ts";
import { assertAuthorRequest } from "./author-request.ts";
import type { BranchChanged } from "./claim-state.ts";
import {
  assertBranchAssigned,
  assertClosedMergeRecovery,
  claimedState,
} from "./claim-state.ts";

const CLAIM_REQUEST = z.looseObject({
  lane: z.string().min(1),
  number: z.number().int().positive(),
  sweepId: z.string().min(1),
  stage: z.enum(STAGES).optional(),
});

// The issue's fields the claim reads beyond those issue-context reads.
const CLAIMED_ISSUE = z.looseObject({
  labels: z.array(z.looseObject({ name: z.string() })),
  state: z.string(),
});

interface ClaimLost {
  lost: true;
  holder: string | null;
  posted: boolean;
}

interface ClaimWon {
  state: IssueState;
  claim: { id: number; posted: boolean };
  remoteHead: string | null;
  // Present when GitHub's branch head is neither the saved head nor the
  // pipeline's own push; the job decides what that means.
  branchChanged?: BranchChanged;
  issueFile: string;
  issue: Issue;
  comments: IssueComment[];
  paths: {
    worktree: string;
    runDir: string;
    issueFile: string;
  };
}

type ClaimRequest = z.infer<typeof CLAIM_REQUEST>;

// Labels the issue, and its PR if it has one, as worked on, and clears the
// labels that parked or stopped it.
function labelWorking(
  cfg: Config,
  n: number,
  labels: readonly { name: string }[],
  pr: number | null,
): void {
  const stops = labels.map((label) => label.name).filter(isStopLabel);
  setLabels(cfg, n, [LABELS.working.name], [LABELS.needsInfo.name, ...stops]);
  if (pr !== null) {
    setLabels(cfg, pr, [LABELS.working.name]);
    clearStopLabels(cfg, pr);
  }
}

// Readies the issue's code checkout, and says what a reset of it did. A new
// checkout is set up for the writer's own test runs; an existing one
// moves to an adopted push's head, keeping any commits the branch lacks.
function readyCheckouts(
  cfg: Config,
  n: number,
  claimed: { remote: string | null; adopted: boolean },
  now: Date,
): string | null {
  const wt = paths.worktree(cfg, n);
  const existed = fs.existsSync(path.join(wt, ".git"));
  ensureWorktree(cfg, n);
  if (!existed) {
    return null;
  }
  if (!claimed.adopted || claimed.remote === null) {
    return null;
  }
  fetchIn(cfg, wt, paths.branch(cfg, n));
  return resetKeepingUnpushed(wt, n, claimed.remote, now);
}

function leased(state: IssueState, req: ClaimRequest, now: Date): IssueState {
  const lease = {
    lane: laneOf(req),
    sweepId: req.sweepId,
    at: now.toISOString(),
  };
  return { ...state, lease };
}

interface PreparedClaim {
  claimed: ReturnType<typeof claimedState>;
  claimId: number;
  posted: boolean;
  now: Date;
  existed: boolean;
  entry: string | null;
}

function claimCheckout(
  cfg: Config,
  req: ClaimRequest,
  context: IssueContext,
  recovering: boolean,
): ClaimLost | PreparedClaim {
  const n = req.number;
  let lost: ClaimLost = { lost: true, holder: null, posted: false };
  const prepared = withCheckoutSlot(cfg, n, () => {
    const race = raceForClaim(cfg, n, req, context.comments);
    if (!race.won || race.claimId === undefined) {
      lost = { lost: true, holder: race.holder ?? null, posted: race.posted };
      return null;
    }
    const now = new Date();
    const claimed = claimedState(cfg, n, context.comments, {
      now,
      stage: firstStage(req),
    });
    if (recovering) {
      // Only the winning claimant may reopen; this grants no writer authority.
      gh(cfg, "merge", ["issue", "reopen", String(n), "-R", cfg.repo]);
      if (issueState(cfg, n) !== "open") {
        throw new OpsError(
          `could not confirm #${n} reopened for Merge recovery`,
        );
      }
    }
    const existed = fs.existsSync(path.join(paths.worktree(cfg, n), ".git"));
    let entry: string | null = null;
    if (claimed.state.stage !== "done") {
      entry = readyCheckouts(cfg, n, claimed, now);
    }
    return {
      claimed,
      claimId: race.claimId,
      posted: race.posted,
      now,
      existed,
      entry,
    };
  });
  return prepared ?? lost;
}

function awaitingAnswer(
  cfg: Config,
  n: number,
  context: { issue: Issue; comments: IssueComment[] },
): boolean {
  const saved = readClaimState(cfg, n, context.comments);
  return (
    saved?.asked?.inputs ===
    trustedInputsHash(cfg, context.issue, context.comments)
  );
}

function firstStage(req: ClaimRequest): "author" | "implement" {
  if (req.stage === "author") {
    return "author";
  }
  return "implement";
}

function claim(
  cfg: Config,
  request: unknown,
): ClaimLost | ClaimWon | { waiting: "answer" } {
  const req = parseRequest(CLAIM_REQUEST, "claim", request);
  const n = req.number;
  const context = writeIssueContext(cfg, n);
  const issue = CLAIMED_ISSUE.parse(context.issue);
  const recovering = issue.state === "closed";
  if (recovering) {
    assertClosedMergeRecovery(cfg, n, context.comments);
  } else if (issue.state !== "open") {
    throw new OpsError(`#${n} is not open`);
  }
  assertBranchAssigned(cfg, n, context.comments);
  if (awaitingAnswer(cfg, n, context)) {
    return { waiting: "answer" };
  }
  assertAuthorRequest(cfg, readClaimState(cfg, n, context.comments), req.stage);
  // Explicit stage jobs need the same metadata clone that legacy discovery
  // initialized. Do this before posting a claim; failure leaves no lease.
  if (!fs.existsSync(path.join(paths.clone(cfg), ".git"))) {
    ensureClone(cfg);
  }
  const prepared = claimCheckout(cfg, req, context, recovering);
  if ("lost" in prepared) {
    return prepared;
  }
  const { claimed, claimId, posted, now, existed, entry } = prepared;
  pruneLaneResources(cfg);
  let state = leased(claimed.state, req, now);
  if (state.stage !== "done") {
    if (!existed && cfg.laneSlots === undefined) {
      setUpCheckout(cfg, n, paths.worktree(cfg, n), "setup-at-claim.log");
    }
    if (entry !== null) {
      state = withLog(state, entry, now);
    }
    labelWorking(cfg, n, issue.labels, state.pr);
  }
  writeState(cfg, n, state);
  // Save authority before lane setup: a failed setup keeps its checkout and
  // slot, and an explicit retry must not look like unsigned prior work.
  if (state.stage !== "done" && cfg.laneSlots !== undefined) {
    setUpCheckout(cfg, n, paths.worktree(cfg, n), "setup-at-claim.log");
  }
  const won: ClaimWon = {
    state,
    claim: { id: claimId, posted },
    remoteHead: claimed.remote,
    issueFile: context.file,
    issue: context.issue,
    comments: context.comments,
    paths: {
      worktree: paths.worktree(cfg, n),
      runDir: paths.runDir(cfg, n),
      issueFile: context.file,
    },
  };
  if (claimed.branchChanged !== null) {
    won.branchChanged = claimed.branchChanged;
  }
  return won;
}

export { claim };
