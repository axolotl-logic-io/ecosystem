// Reconcile an authenticated exact-head intent using reads only. Lost push
// responses do not erase intent and never authorize another target mutation.
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { FULL_SHA, legacyWikiOf } from "../land-provenance.ts";
import { OpsError } from "../ops-error.ts";
import { currentRevision } from "../revision.ts";
import { writeState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import { exactTarget, intendedBase } from "./fast-forward-evidence.ts";
import { assertFastForward } from "./land-branch.ts";
import type { RecoveryReply } from "./land-recovery.ts";
import {
  boundAttempt,
  confirmAuthorization,
  saveReceipt,
} from "./landing-attempt.ts";
import { viewForLand } from "./pr-merge.ts";

function readFastForward(
  cfg: Config,
  number: number,
  state: IssueState,
  withinDeadline: () => boolean,
): RecoveryReply {
  const attempt = boundAttempt(cfg, number, state);
  const result = FULL_SHA.parse(attempt.authorized.code);
  const codeMerged = { pr: attempt.pr, sha: result };
  const base = intendedBase(cfg, number, state, codeMerged);
  if (base === undefined) {
    throw new OpsError("fast-forward has no exact intended operation");
  }
  const wt = paths.worktree(cfg, number);
  assertFastForward(wt, base, result);
  if (exactTarget(cfg, wt) !== result) {
    throw new OpsError(
      "configured target does not equal the intended reviewed commit",
    );
  }
  // Keep the exact landed fact even when changed inputs or PR binding prevent
  // granting an own receipt. This fact alone grants no writer or clearance.
  if (
    state.codeLanded !== null &&
    JSON.stringify(state.codeLanded) !== JSON.stringify(codeMerged)
  ) {
    throw new OpsError("fast-forward differs from retained landed-code fact");
  }
  const observed = { ...state, codeMerged };
  writeState(cfg, number, observed);
  confirmAuthorization(state, attempt);
  const view = viewForLand(cfg, attempt.pr);
  if (
    view.headRefName !== attempt.branch ||
    view.headRefOid !== result ||
    (view.state !== "OPEN" && view.state !== "MERGED") ||
    (view.state === "MERGED" && view.mergeCommit?.oid !== result)
  ) {
    throw new OpsError("PR binding differs from intended fast-forward");
  }
  const current = currentRevision(cfg, number, observed);
  if (
    current.baseSha !== result ||
    current.pr?.number !== attempt.pr ||
    current.pr.headSha !== result ||
    current.revision.inputs !== attempt.authorized.inputs ||
    legacyWikiOf(current.revision) !== legacyWikiOf(attempt.authorized) ||
    exactTarget(cfg, wt) !== result
  ) {
    throw new OpsError(
      "target, PR or trusted inputs no longer match the intended fast-forward",
    );
  }
  if (!withinDeadline()) {
    throw new OpsError("confirmation deadline reached during evidence reads");
  }
  saveReceipt(cfg, number, observed, attempt.authorized);
  return { landed: true, mergeCommit: result, headSha: result };
}

export { readFastForward };
