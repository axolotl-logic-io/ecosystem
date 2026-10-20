// The state a claim carries on from: the saved one (a new issue's first, a
// stopped one's with its stop lifted), with the pipeline's own unsaved push
// adopted (adopt-push.ts) and then its code merge reconciled against GitHub
// (revision.ts). The branch-changed defense is the caller's: this module
// only reports a branch head that moved past the saved one without the
// pipeline, as a diagnostic.

import fs from "node:fs";
import { adoptPush } from "../adopt-push.ts";
import { assignedBranch } from "../branch-binding.ts";
import { lastPush } from "../checkouts.ts";
import { isLegacyPipelineComment } from "../comment-marks.ts";
import type { IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { remoteHead } from "../git-state.ts";
import { git } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { run } from "../process.ts";
import { codeMergedOf, issuePullRequest } from "../revision.ts";
import { readClaimState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import {
  mergeAuthorization,
  newIssueState,
  resumeOf,
  withLog,
} from "../state.ts";
import { historicalPrFor } from "./prs.ts";

// `show-ref --exists` distinguishes absence from unreadable repository history.
const MISSING_REF = 2;
const FULL_SHA = /^[0-9a-f]{40}$/u;

function hasLocalBranch(dir: string, branch: string): boolean {
  if (fs.statSync(dir, { throwIfNoEntry: false }) === undefined) {
    return false;
  }
  const result = run(
    "git",
    ["-C", dir, "show-ref", "--exists", `refs/heads/${branch}`],
    { allowFail: true },
  );
  if (result.code === MISSING_REF) {
    return false;
  }
  // An existing ref or unreadable history both require reconciliation.
  return true;
}

// A branch head on GitHub that is neither the saved one nor the pipeline's
// own push.
interface BranchChanged {
  saved: string;
  remote: string;
}

interface ClaimedState {
  state: IssueState;
  remote: string | null;
  // Whether a push of the pipeline's own was adopted.
  adopted: boolean;
  branchChanged: BranchChanged | null;
}

// The saved state the claim starts from. A done issue is claimed only to
// reconcile its completion: it must have saved what merged.
function assertFirstClaim(
  cfg: Config,
  number: number,
  comments: readonly IssueComment[],
): void {
  const priorComment = comments.some(
    (item) =>
      item.user?.login.toLowerCase() === cfg.mergeAccount.toLowerCase() ||
      isLegacyPipelineComment(cfg, item),
  );
  const local = [paths.runDir(cfg, number)];
  if (cfg.checkout?.issue !== number) {
    local.push(paths.worktree(cfg, number));
  }
  // Empty run folders and the current invocation's log/input are not prior work.
  const priorFiles = local.some(
    (dir) =>
      fs.existsSync(dir) &&
      fs
        .readdirSync(dir)
        .some(
          (name) =>
            !["job.log", "issue.md", "job.json", "job.sock"].includes(name),
        ),
  );
  const branch = paths.branch(cfg, number);
  const priorCode = [paths.clone(cfg), paths.mirror(cfg)].some((dir) =>
    hasLocalBranch(dir, branch),
  );
  const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
  const remote = git(cfg, "dev", ["ls-remote", url, `refs/heads/${branch}`]);
  const wiki = hasLocalBranch(paths.wikiMirror(cfg), branch);
  if (
    priorComment ||
    priorFiles ||
    priorCode ||
    wiki ||
    remote.stdout.trim() !== "" ||
    historicalPrFor(cfg, number) !== null
  ) {
    throw new OpsError(
      `#${number} has prior pipeline work but no saved authority; stop for reconciliation`,
    );
  }
}

function startingState(
  cfg: Config,
  n: number,
  comments: readonly IssueComment[],
): IssueState {
  const saved = readClaimState(cfg, n, comments);
  if (saved === null) {
    assertFirstClaim(cfg, n, comments);
    return { ...newIssueState(n), branch: assignedBranch(cfg, n, null) };
  }
  if (saved.stage === "done" && saved.merged === null) {
    throw new OpsError(`#${n} is done`);
  }
  return { ...resumeOf(saved), branch: assignedBranch(cfg, n, saved) };
}

// Throws, before a claim writes anything, when the issue's saved state is
// bound to another branch than the one assigned (branch-binding.ts).
function assertBranchAssigned(
  cfg: Config,
  n: number,
  comments: readonly IssueComment[],
): void {
  const state = readClaimState(cfg, n, comments);
  if (state === null) {
    assertFirstClaim(cfg, n, comments);
  }
  assignedBranch(cfg, n, state);
}

// Closed issues may recover only an incomplete Merge, never initialize work or
// replay completion. This is claim eligibility, not own-merge authorization:
// without a saved receipt, the existing external-postmerge gates still apply.
function assertClosedMergeRecovery(
  cfg: Config,
  n: number,
  comments: readonly IssueComment[],
): void {
  const saved = readClaimState(cfg, n, comments);
  if (
    saved === null ||
    resumeOf(saved).stage !== "merge" ||
    saved.pr === null
  ) {
    throw new OpsError(`#${n} is not open`);
  }
  const pr = issuePullRequest(cfg, n, saved);
  const merged = codeMergedOf(pr);
  const authorized = mergeAuthorization(saved);
  const attempt = saved.mergeAttempt;
  if (
    attempt !== null &&
    (attempt.repo !== cfg.repo ||
      attempt.pr !== saved.pr ||
      attempt.target !== cfg.baseBranch ||
      attempt.branch !== paths.branch(cfg, n) ||
      attempt.authorized.code !== pr?.headSha ||
      (attempt.result !== null && attempt.result !== merged?.sha))
  ) {
    throw new OpsError(
      `#${n}'s saved merge attempt is not confirmed by GitHub`,
    );
  }
  if (
    pr === null ||
    merged === null ||
    !FULL_SHA.test(merged.sha) ||
    !FULL_SHA.test(pr.headSha) ||
    (saved.headSha !== null &&
      saved.headSha !== pr.headSha &&
      saved.headSha !== saved.codeMerged?.sha) ||
    (saved.codeMerged !== null &&
      (saved.codeMerged.pr !== merged.pr ||
        saved.codeMerged.sha !== merged.sha)) ||
    (saved.merged !== null &&
      (saved.merged.code !== merged.sha ||
        (authorized?.code !== null &&
          authorized?.code !== undefined &&
          authorized.code !== pr.headSha)))
  ) {
    throw new OpsError(`#${n}'s incomplete Merge is not confirmed by GitHub`);
  }
}

// `state` with its PR and code merge as GitHub reports them. A recorded
// code merge GitHub doesn't confirm, or a completion GitHub reports another
// code merge for (none, for a change that lives only in the wiki), throws:
// the claim never clears or replaces a merge it recorded.
function reconciled(
  cfg: Config,
  n: number,
  state: IssueState,
  now: Date,
): IssueState {
  // Reconciliation owns delayed PR reads after an attempted mutation. A
  // stale OPEN/read failure must not clear truth or divert recovery to a writer.
  if (state.mergeAttempt !== null) {
    return state;
  }
  const pr = issuePullRequest(cfg, n, state);
  const codeMerged = codeMergedOf(pr);
  const recorded = state.codeMerged ?? null;
  if (
    recorded !== null &&
    (codeMerged === null ||
      codeMerged.pr !== recorded.pr ||
      codeMerged.sha !== recorded.sha)
  ) {
    throw new OpsError(
      `GitHub doesn't confirm #${n}'s recorded code merge (PR #${recorded.pr} at ${recorded.sha})`,
    );
  }
  if (
    state.stage === "done" &&
    state.merged?.code !== (codeMerged?.sha ?? null)
  ) {
    throw new OpsError(
      `#${n} is done, but GitHub doesn't confirm the merge it saved`,
    );
  }
  const next: IssueState = { ...state, pr: pr?.number ?? null, codeMerged };
  if (recorded === null && codeMerged !== null) {
    return withLog(
      next,
      `GitHub reports PR #${codeMerged.pr} merged as ${codeMerged.sha}`,
      now,
    );
  }
  return next;
}

// The branch head GitHub has that the saved state doesn't, unless the code
// merged, which leaves the branch head no longer the code's revision.
function branchChangedOf(
  state: IssueState,
  remote: string | null,
): BranchChanged | null {
  const { headSha, codeMerged } = state;
  if (
    state.mergeAttempt !== null ||
    codeMerged !== null ||
    headSha === null ||
    remote === null
  ) {
    return null;
  }
  if (remote === headSha) {
    return null;
  }
  return { saved: headSha, remote };
}

function claimedState(
  cfg: Config,
  n: number,
  comments: readonly IssueComment[],
  now: Date,
): ClaimedState {
  const start = startingState(cfg, n, comments);
  const remote = remoteHead(cfg, n);
  const adoptedState = adoptPush(start, remote, lastPush(cfg, n), now);
  const state = reconciled(cfg, n, adoptedState ?? start, now);
  return {
    state,
    remote,
    adopted: adoptedState !== null,
    branchChanged: branchChangedOf(state, remote),
  };
}

export type { BranchChanged, ClaimedState };
export { assertBranchAssigned, assertClosedMergeRecovery, claimedState };
