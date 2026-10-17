// The claim op: races other lanes for an issue (see raceForClaim) and, when
// this lane wins, leases the issue to it and readies its worktree. A start
// (new work, a removed agent:stopped-* label, or answered questions) restarts
// the state from the issue's branch; a lane picking up a lapsed lease carries
// on at the saved stage. A claim of an agent:needs-info issue that no allowed
// user has answered changes nothing and replies that it waits for an answer.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureWorktree } from "../checkouts.ts";
import type { LaneRequest } from "../claims.ts";
import { laneOf, raceForClaim } from "../claims.ts";
import type { IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { writeIssueContext } from "../issue-context.ts";
import { clearStopLabels, LABELS, setLabels } from "../labels.ts";
import { OpsError, shell } from "../process.ts";
import { checkedSpecFiles, specFilesMissing } from "../restart-spec.ts";
import type { State } from "../state.ts";
import { readState, writeState } from "../state.ts";
import { isStopLabel } from "../stops.ts";
import { ensureWiki } from "../wiki.ts";
import type { ClaimedIssue, Prereq } from "./claim-state.ts";
import { CLAIMED_ISSUE, claimedState, hasNeedsInfo } from "./claim-state.ts";
import { answeredSince } from "./sweep-verdict.ts";

const MS_PER_MINUTE = 60_000;

const CLAIM_REQUEST = z.looseObject({
  lane: z.unknown().optional(),
  number: z.number(),
  // The issue whose branch this one starts on, if it has none yet (#268).
  stackOn: z.number().int().positive().nullish(),
  sweepId: z.unknown().optional(),
});

// The config keys only the claim reads; loadConfig applied their defaults.
const CLAIM_SETTINGS = z.looseObject({
  commandTimeoutMinutes: z.number(),
  commands: z.looseObject({ setup: z.string().nullish() }),
});

const PR = z.number().nullish();

interface ClaimLost {
  lost: true;
  holder: string | null | undefined;
  posted: boolean;
  waited: number | undefined;
}

interface ClaimWon {
  state: State;
  // The test and stub files a restart's spec documents that the branch
  // lacks, when there are any.
  specMissing?: string[];
  claim: {
    id: number | undefined;
    posted: boolean;
    waited: number | undefined;
  };
  remoteHead: string | null;
  paths: {
    worktree: string;
    runDir: string;
    issueFile: string;
    handoffFile: string;
    wiki: string | null;
  };
}

// The reply for an issue whose questions no allowed user has answered.
interface ClaimWaiting {
  waiting: "answer";
}

// True when the issue's questions are open and no allowed user has answered.
function awaitsAnswer(
  cfg: Config,
  n: number,
  issue: ClaimedIssue,
  comments: readonly IssueComment[],
): boolean {
  const { state } = readState(cfg, n, comments);
  return hasNeedsInfo(issue) && !answeredSince(cfg, comments, state);
}

// Sets up a new worktree now, not only at verify, so the writer's own test
// runs get this issue's database and ports instead of the shared defaults. A
// failure is only logged: verify runs setup again and reports it.
function setUpAtClaim(cfg: Config, n: number, wt: string): void {
  const { commandTimeoutMinutes, commands } = CLAIM_SETTINGS.parse(cfg);
  const { setup } = commands;
  if (setup === undefined || setup === null || setup === "") {
    return;
  }
  const log = path.join(paths.runDir(cfg, n), "setup-at-claim.log");
  shell(setup, wt, log, commandTimeoutMinutes * MS_PER_MINUTE);
}

// Labels the issue, and its PR if it has one, as worked on, and clears the
// labels that parked or stopped it.
function labelWorking(
  cfg: Config,
  n: number,
  issue: ClaimedIssue,
  state: State,
): void {
  const stops = issue.labels.map((label) => label.name).filter(isStopLabel);
  setLabels(cfg, n, [LABELS.working.name], [LABELS.needsInfo.name, ...stops]);
  const pr = PR.safeParse(state.pr).data;
  if (pr !== undefined && pr !== null && pr !== 0) {
    setLabels(cfg, pr, [LABELS.working.name]);
    clearStopLabels(cfg, pr);
  }
}

interface Taken {
  state: State;
  remote: string | null;
  wt: string;
  wiki: string | null;
  specMissing: string[];
}

// Leases the issue to this lane and readies its worktree and wiki. A restart
// past spec checks the test and stub files its spec documents against the
// branch (checkedSpecFiles).
function take(
  cfg: Config,
  req: LaneRequest & { number: number; stackOn?: Prereq },
  issue: ClaimedIssue,
  comments: readonly IssueComment[],
): Taken {
  const n = req.number;
  const context = { comments, stackOn: req.stackOn };
  const begun = claimedState(cfg, n, issue, context);
  const { state: claimed, remote } = begun;
  const lease = {
    lane: laneOf(req),
    sweepId: req.sweepId,
    at: new Date().toISOString(),
  };
  const leased = { ...claimed, lease };
  const newWorktree = !fs.existsSync(path.join(paths.worktree(cfg, n), ".git"));
  const wt = ensureWorktree(cfg, n, claimed.stackedOn ?? null);
  const wiki = ensureWiki(cfg, n);
  if (newWorktree) {
    setUpAtClaim(cfg, n, wt);
  }
  let missing: string[] = [];
  if (begun.restarted) {
    missing = specFilesMissing(wt, leased);
  }
  const checked = checkedSpecFiles(leased, missing, new Date());
  const { state, specMissing } = checked;
  labelWorking(cfg, n, issue, state);
  writeState(cfg, n, state);
  return { state, remote, wt, wiki, specMissing };
}

function claim(
  cfg: Config,
  request: unknown,
): ClaimLost | ClaimWon | ClaimWaiting {
  const req = CLAIM_REQUEST.parse(request);
  const n = req.number;
  const context = writeIssueContext(cfg, n);
  const issue = CLAIMED_ISSUE.parse(context.issue);
  if (issue.state !== "open") {
    throw new OpsError(`#${n} is not open`);
  }
  if (awaitsAnswer(cfg, n, issue, context.comments)) {
    return { waiting: "answer" };
  }
  const race = raceForClaim(cfg, n, req, context.comments);
  const { posted, waited } = race;
  if (!race.won) {
    return { lost: true, holder: race.holder, posted, waited };
  }
  const taken = take(cfg, req, issue, context.comments);
  const { state, remote, wt, wiki, specMissing } = taken;
  const runDir = paths.runDir(cfg, n);
  const won: ClaimWon = {
    state,
    claim: { id: race.claimId, posted, waited },
    remoteHead: remote,
    paths: {
      worktree: wt,
      runDir,
      issueFile: context.file,
      handoffFile: paths.handoff(cfg, n),
      wiki,
    },
  };
  if (specMissing.length > 0) {
    won.specMissing = specMissing;
  }
  return won;
}

export { claim };
