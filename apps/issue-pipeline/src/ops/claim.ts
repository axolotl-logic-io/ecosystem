// The claim op: races other lanes for an issue (see raceForClaim) and, when
// this lane wins, leases the issue to it and readies its worktree. A start
// (new work, a removed agent:stopped-* label, or answered questions) restarts
// the state from the issue's branch; a lane picking up a lapsed lease carries
// on at the saved stage. A claim of an agent:needs-info issue that no allowed
// user has answered changes nothing and replies that it waits for an answer.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureWorktree, lastPush } from "../checkouts.ts";
import type { LaneRequest } from "../claims.ts";
import { laneOf, raceForClaim } from "../claims.ts";
import type { IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { branchHasWork, fetchIn, remoteHead } from "../git-state.ts";
import { writeIssueContext } from "../issue-context.ts";
import { clearStopLabels, LABELS, setLabels } from "../labels.ts";
import { OpsError, run, shell } from "../process.ts";
import { adoptPush, startState } from "../start-state.ts";
import type { State } from "../state.ts";
import { readState, writeState } from "../state.ts";
import { isStopLabel } from "../stops.ts";
import { ensureWiki, wikiBranchHasWork } from "../wiki.ts";
import { openPrFor } from "./prs.ts";
import { answeredSince, issueDepth } from "./sweep-verdict.ts";

const MS_PER_MINUTE = 60_000;

const CLAIM_REQUEST = z.looseObject({
  lane: z.unknown().optional(),
  number: z.number(),
  sweepId: z.unknown().optional(),
});

// The issue's fields the claim reads, beyond those issue-context reads.
const CLAIMED_ISSUE = z.looseObject({
  body: z.string().nullish(),
  labels: z.array(z.looseObject({ name: z.string() })),
  state: z.string().nullish(),
});

// The config keys only the claim reads; loadConfig applied their defaults.
const CLAIM_SETTINGS = z.looseObject({
  commandTimeoutMinutes: z.number(),
  commands: z.looseObject({ setup: z.string().nullish() }),
});

const PR = z.number().nullish();

type ClaimedIssue = z.infer<typeof CLAIMED_ISSUE>;

interface ClaimLost {
  lost: true;
  holder: string | null | undefined;
  posted: boolean;
  waited: number | undefined;
}

interface ClaimWon {
  state: State;
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

// The open (or draft) PR from the issue's branch, and whether the issue holds
// work: code changes on a branch with an open PR, or commits on the wiki's
// agent/issue-<n> that the wiki lacks, with or without a PR or code branch.
function branchWork(
  cfg: Config,
  n: number,
  remote: string | null,
): { pr: number | null; hasWork: boolean } {
  let pr: number | null = null;
  let codeWork = false;
  if (remote !== null) {
    pr = openPrFor(cfg, n) ?? null;
    codeWork = pr !== null && branchHasWork(cfg, n, remote);
  }
  return { pr, hasWork: codeWork || wikiBranchHasWork(cfg, n) };
}

// Moves a worktree with no commits past the base to the base's head on
// GitHub, dropping its edits. A worktree with commits of its own is kept.
function resetToBase(cfg: Config, wt: string): void {
  const base = cfg.baseBranch;
  fetchIn(cfg, wt, `+refs/heads/${base}:refs/remotes/origin/${base}`);
  const ahead = run("git", [
    "-C",
    wt,
    "rev-list",
    "--count",
    `origin/${base}..HEAD`,
  ]);
  if (Number(ahead.stdout) !== 0) {
    return;
  }
  run("git", ["-C", wt, "reset", "--hard", `origin/${base}`]);
  run("git", ["-C", wt, "clean", "-fd"]);
}

// Puts an existing worktree back at the branch head on GitHub or, when the
// issue has no branch there, at the base unless it holds commits of its own.
function resetWorktree(cfg: Config, n: number, remote: string | null): void {
  const wt = paths.worktree(cfg, n);
  if (!fs.existsSync(path.join(wt, ".git"))) {
    return;
  }
  if (remote === null) {
    resetToBase(cfg, wt);
    return;
  }
  fetchIn(cfg, wt, paths.branch(n));
  run("git", ["-C", wt, "reset", "--hard", remote]);
  run("git", ["-C", wt, "clean", "-fd"]);
}

// True when the issue has questions open (agent:needs-info).
function hasNeedsInfo(issue: ClaimedIssue): boolean {
  return issue.labels.some((label) => label.name === LABELS.needsInfo.name);
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

// The state this claim carries on from, the saved one mid-stage or a restart
// from the issue's branch, and the branch's head on GitHub.
function claimedState(
  cfg: Config,
  n: number,
  issue: ClaimedIssue,
  comments: readonly IssueComment[],
): { state: State; remote: string | null } {
  const { state: saved } = readState(cfg, n, comments);
  const remote = remoteHead(cfg, n);
  const answered = hasNeedsInfo(issue) && answeredSince(cfg, comments, saved);
  const ended = saved?.stage === "stopped" || saved?.stage === "done";
  if (saved !== null && !ended && !answered) {
    const adopted = adoptPush(saved, remote, lastPush(cfg, n), new Date());
    if (adopted === null) {
      return { state: saved, remote };
    }
    resetWorktree(cfg, n, remote);
    return { state: adopted, remote };
  }
  const { pr, hasWork } = branchWork(cfg, n, remote);
  const depth = issueDepth(issue.body);
  const now = new Date();
  const start = { n, depth, remote, pr, hasWork, answered, now };
  const state = startState(saved, start);
  resetWorktree(cfg, n, remote);
  return { state, remote };
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

// Leases the issue to this lane and readies its worktree and wiki.
function take(
  cfg: Config,
  req: LaneRequest & { number: number },
  issue: ClaimedIssue,
  comments: readonly IssueComment[],
): { state: State; remote: string | null; wt: string; wiki: string | null } {
  const n = req.number;
  const { state: claimed, remote } = claimedState(cfg, n, issue, comments);
  const lease = {
    lane: laneOf(req),
    sweepId: req.sweepId,
    at: new Date().toISOString(),
  };
  const state = { ...claimed, lease };
  const newWorktree = !fs.existsSync(path.join(paths.worktree(cfg, n), ".git"));
  const wt = ensureWorktree(cfg, n);
  const wiki = ensureWiki(cfg, n);
  if (newWorktree) {
    setUpAtClaim(cfg, n, wt);
  }
  labelWorking(cfg, n, issue, state);
  writeState(cfg, n, state);
  return { state, remote, wt, wiki };
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
  const { state, remote, wt, wiki } = take(cfg, req, issue, context.comments);
  const runDir = paths.runDir(cfg, n);
  return {
    state,
    claim: { id: race.claimId, posted, waited },
    remoteHead: remote,
    paths: {
      worktree: wt,
      runDir,
      issueFile: context.file,
      handoffFile: path.join(runDir, "handoff.md"),
      wiki,
    },
  };
}

export { claim };
