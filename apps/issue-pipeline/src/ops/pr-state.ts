// Draft creation is not a checkpoint until its actual identity is validated,
// saved and readable again. Failure leaves any created PR discoverable across
// all states; it never authorizes a writer or fabricates a landing receipt.
import { assignedBranch } from "../branch-binding.ts";
import type { Config } from "../config.ts";
import { gh } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { pullRequest } from "../revision.ts";
import { readWriteState } from "../saved-state.ts";
import { historicalPrFor } from "./prs.ts";
import { saveIssueState } from "./save-state.ts";

function saveDraftAuthority(
  cfg: Config,
  n: number,
  pr: number,
  headSha: string,
): void {
  const state = readWriteState(cfg, n);
  assignedBranch(cfg, n, state);
  const actual = pullRequest(cfg, n, pr);
  if (
    state.mergeAttempt !== null ||
    state.codeMerged !== null ||
    (state.merged !== null && state.merged.code !== null) ||
    (state.pr !== null && state.pr !== pr) ||
    actual.state !== "OPEN" ||
    actual.headSha !== headSha
  ) {
    throw new OpsError(`PR #${pr} has no matching open draft authority`);
  }
  saveIssueState(cfg, n, { ...state, pr });
  const saved = readWriteState(cfg, n);
  if (saved.pr !== pr) {
    throw new OpsError(`PR #${pr}'s authority save is not confirmed`);
  }
}

// `reopen` is an explicit recovery request, not permission to push first.
// Never reopen a different/merged PR or hide ambiguous historical authority.
function recoverDraft(cfg: Config, n: number, reopen: number): void {
  const saved = readWriteState(cfg, n);
  assignedBranch(cfg, n, saved);
  const pr = saved.pr ?? historicalPrFor(cfg, n);
  if (
    pr !== reopen ||
    saved.mergeAttempt !== null ||
    saved.codeMerged !== null ||
    (saved.merged !== null && saved.merged.code !== null)
  ) {
    throw new OpsError(`PR #${reopen} is not recoverable draft authority`);
  }
  const before = pullRequest(cfg, n, pr);
  if (before.state === "MERGED") {
    throw new OpsError(`PR #${pr} merged; refusing draft recovery`);
  }
  if (before.state === "CLOSED") {
    gh(cfg, "dev", ["pr", "reopen", String(pr), "-R", cfg.repo]);
  }
  saveDraftAuthority(cfg, n, pr, before.headSha);
}

export { recoverDraft, saveDraftAuthority };
