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
import type { Issue } from "../issue-context.ts";
import { writeIssueContext } from "../issue-context.ts";
import { clearStopLabels, LABELS, setLabels } from "../labels.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import { writeState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import { withLog } from "../state.ts";
import { isStopLabel } from "../stops.ts";
import { resetKeepingUnpushed } from "../unpushed.ts";
import { ensureWiki } from "../wiki.ts";
import type { BranchChanged } from "./claim-state.ts";
import { assertBranchAssigned, claimedState } from "./claim-state.ts";

const CLAIM_REQUEST = z.looseObject({
  lane: z.string().min(1),
  number: z.number().int().positive(),
  sweepId: z.string().min(1),
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
    wiki: string | null;
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

// Readies the issue's code and wiki checkouts and returns the wiki's path.
// A new checkout is set up for the writer's own test runs; an existing one
// moves to an adopted push's head, keeping any commits the branch lacks.
function readyCheckouts(
  cfg: Config,
  n: number,
  claimed: { remote: string | null; adopted: boolean },
  now: Date,
): { wiki: string | null; entry: string | null } {
  const wt = paths.worktree(cfg, n);
  const existed = fs.existsSync(path.join(wt, ".git"));
  ensureWorktree(cfg, n);
  const wiki = ensureWiki(cfg, n);
  if (!existed) {
    setUpCheckout(cfg, n, wt, "setup-at-claim.log");
    return { wiki, entry: null };
  }
  if (!claimed.adopted || claimed.remote === null) {
    return { wiki, entry: null };
  }
  fetchIn(cfg, wt, paths.branch(cfg, n));
  return { wiki, entry: resetKeepingUnpushed(wt, n, claimed.remote, now) };
}

function leased(state: IssueState, req: ClaimRequest, now: Date): IssueState {
  const lease = {
    lane: laneOf(req),
    sweepId: req.sweepId,
    at: now.toISOString(),
  };
  return { ...state, lease };
}

function claim(cfg: Config, request: unknown): ClaimLost | ClaimWon {
  const req = parseRequest(CLAIM_REQUEST, "claim", request);
  const n = req.number;
  const context = writeIssueContext(cfg, n);
  const issue = CLAIMED_ISSUE.parse(context.issue);
  if (issue.state !== "open") {
    throw new OpsError(`#${n} is not open`);
  }
  assertBranchAssigned(cfg, n, context.comments);
  // Explicit stage jobs need the same metadata clone that legacy discovery
  // initialized. Do this before posting a claim; failure leaves no lease.
  if (!fs.existsSync(path.join(paths.clone(cfg), ".git"))) {
    ensureClone(cfg);
  }
  const race = raceForClaim(cfg, n, req, context.comments);
  if (!race.won || race.claimId === undefined) {
    return { lost: true, holder: race.holder ?? null, posted: race.posted };
  }
  const now = new Date();
  const claimed = claimedState(cfg, n, context.comments, now);
  let state = leased(claimed.state, req, now);
  let wiki: string | null = null;
  if (state.stage !== "done") {
    const ready = readyCheckouts(cfg, n, claimed, now);
    ({ wiki } = ready);
    if (ready.entry !== null) {
      state = withLog(state, ready.entry, now);
    }
    labelWorking(cfg, n, issue.labels, state.pr);
  }
  writeState(cfg, n, state);
  const won: ClaimWon = {
    state,
    claim: { id: race.claimId, posted: race.posted },
    remoteHead: claimed.remote,
    issueFile: context.file,
    issue: context.issue,
    comments: context.comments,
    paths: {
      worktree: paths.worktree(cfg, n),
      runDir: paths.runDir(cfg, n),
      issueFile: context.file,
      wiki,
    },
  };
  if (claimed.branchChanged !== null) {
    won.branchChanged = claimed.branchChanged;
  }
  return won;
}

export { claim };
