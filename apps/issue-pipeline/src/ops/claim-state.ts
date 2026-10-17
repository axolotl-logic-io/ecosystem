// The state a claim carries on from: the saved one mid-stage, or a start's
// (start-state.ts) from the issue's branch, with the worktree put back at the
// branch's head first. The claim op (claim.ts) leases the issue with it.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { adoptPush } from "../adopt-push.ts";
import { lastPush } from "../checkouts.ts";
import type { IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import {
  branchHasWork,
  fetchIn,
  head,
  patchIdOf,
  remoteHead,
} from "../git-state.ts";
import { LABELS } from "../labels.ts";
import type { StackedOn } from "../stack.ts";
import { claimedStack, measureFrom, resetToStart } from "../stack.ts";
import { startState } from "../start-state.ts";
import type { State } from "../state.ts";
import { readState } from "../state.ts";
import { resetKeepingUnpushed } from "../unpushed.ts";
import { wikiBranchHasWork } from "../wiki.ts";
import { openPrFor } from "./prs.ts";
import { answeredSince, issueDepth } from "./sweep-verdict.ts";

// The issue's fields the claim reads, beyond those issue-context reads.
const CLAIMED_ISSUE = z.looseObject({
  body: z.string().nullish(),
  labels: z.array(z.looseObject({ name: z.string() })),
  state: z.string().nullish(),
});

type ClaimedIssue = z.infer<typeof CLAIMED_ISSUE>;
type Prereq = number | null | undefined;

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

// The patch id of the changes the branch's head on GitHub makes against its
// base or prerequisite, which a clean rebase keeps
// (review-keeps-on-clean-rebase); null when it has no head there.
function branchPatchId(
  cfg: Config,
  remote: string | null,
  stackedOn: StackedOn | null,
): string | null {
  if (remote === null) {
    return null;
  }
  return patchIdOf(paths.clone(cfg), measureFrom(stackedOn, cfg), remote);
}

// Puts an existing worktree back at the branch head on GitHub or, when the
// issue has no branch there, where it starts (stack.ts) unless it holds
// commits of its own.
// Commits the branch lacks are never dropped (#283); returns the log entry
// saying where they were kept, or null when there were none, and whether
// HEAD stayed past the branch with them.
function resetWorktree(
  cfg: Config,
  n: number,
  start: { remote: string | null; stackedOn: StackedOn | null },
): { entry: string | null; kept: boolean } {
  const { remote, stackedOn } = start;
  const wt = paths.worktree(cfg, n);
  if (!fs.existsSync(path.join(wt, ".git"))) {
    return { entry: null, kept: false };
  }
  if (remote === null) {
    resetToStart(cfg, wt, stackedOn);
    return { entry: null, kept: false };
  }
  fetchIn(cfg, wt, paths.branch(n));
  const entry = resetKeepingUnpushed(wt, n, remote, new Date());
  return { entry, kept: head(wt) !== remote };
}

// `state` with the reset's log entry, if it has one, and what the issue is
// stacked on, if it is.
function withEntry(
  state: State,
  entry: string | null,
  on: StackedOn | null,
): State {
  const next: State = { ...state };
  if (on !== null) {
    next.stackedOn = on;
  }
  if (entry !== null) {
    next.log = [...(state.log ?? []), entry];
  }
  return next;
}

// True when the issue has questions open (agent:needs-info).
function hasNeedsInfo(issue: ClaimedIssue): boolean {
  return issue.labels.some((label) => label.name === LABELS.needsInfo.name);
}

// The state this claim carries on from, the saved one mid-stage or a restart
// from the issue's branch, the branch's head on GitHub, and whether it
// restarted. An issue with no branch that is stacked, or asked to be, starts
// on its prerequisite's head.
function claimedState(
  cfg: Config,
  n: number,
  issue: ClaimedIssue,
  context: { comments: readonly IssueComment[]; stackOn: Prereq },
): { state: State; remote: string | null; restarted: boolean } {
  const { comments, stackOn } = context;
  const { state: saved } = readState(cfg, n, comments);
  const remote = remoteHead(cfg, n);
  // Fetched into the worktree or, before it has one, the clone.
  let dir = paths.worktree(cfg, n);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    dir = paths.clone(cfg);
  }
  const stack = { remote, saved: saved?.stackedOn, stackOn };
  const stackedOn = claimedStack(cfg, dir, stack);
  const answered = hasNeedsInfo(issue) && answeredSince(cfg, comments, saved);
  const ended = saved?.stage === "stopped" || saved?.stage === "done";
  if (saved !== null && !ended && !answered) {
    const adopted = adoptPush(saved, remote, lastPush(cfg, n), new Date());
    if (adopted === null && (remote !== null || stackedOn === null)) {
      return { state: saved, remote, restarted: false };
    }
    const { entry } = resetWorktree(cfg, n, { remote, stackedOn });
    const state = withEntry(adopted ?? saved, entry, stackedOn);
    return { state, remote, restarted: false };
  }
  const { pr, hasWork } = branchWork(cfg, n, remote);
  const depth = issueDepth(issue.body);
  const now = new Date();
  const reset = resetWorktree(cfg, n, { remote, stackedOn });
  const keptUnpushed = reset.kept;
  const patchId = branchPatchId(cfg, remote, stackedOn);
  const facts = { remote, patchId, keptUnpushed, answered };
  const start = { n, depth, pr, hasWork, now, ...facts };
  const begun = startState(saved, start);
  const state = withEntry(begun, reset.entry, stackedOn);
  return { state, remote, restarted: true };
}

export type { ClaimedIssue, Prereq };
export { CLAIMED_ISSUE, claimedState, hasNeedsInfo };
