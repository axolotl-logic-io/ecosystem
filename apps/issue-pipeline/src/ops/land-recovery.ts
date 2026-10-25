// Durable uncertainty and bounded read-only recovery of one target mutation.
// FF recovery requires exact authenticated intent; legacy two-parent recovery
// still requires a saved successful response for own provenance. No code writes.
import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { FULL_SHA, legacyWikiOf } from "../land-provenance.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest, sleepMs } from "../process.ts";
import { confirmLanded, currentRevision } from "../revision.ts";
import { readWriteState, writeState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import { readFastForward } from "./fast-forward-recovery.ts";
import { landedParent } from "./landed-graph.ts";
import {
  boundAttempt,
  confirmAuthorization,
  saveReceipt,
} from "./landing-attempt.ts";
import { viewForLand } from "./pr-merge.ts";

interface ConfirmationClock {
  now: () => number;
  sleep: (ms: number) => void;
}

const SYSTEM_CLOCK: ConfirmationClock = {
  now: () => performance.now(),
  sleep: sleepMs,
};
const MS_PER_SECOND = 1000;
const RECOVERY_REQUEST = z.object({ number: z.number().int().positive() });

type RecoveryReply =
  | { landed: true; mergeCommit: string; headSha: string; byHand?: true }
  | { landed: false; reason: string };

function diagnostic(detail: string): RecoveryReply {
  return {
    landed: false,
    reason: `bounded merge recovery: code may already have landed; another merge POST or code writer is not authorized; retain recovery evidence: ${detail}`,
  };
}

function readEvidence(
  cfg: Config,
  number: number,
  state: IssueState,
  withinDeadline: () => boolean,
): RecoveryReply {
  const attempt = boundAttempt(cfg, number, state);
  if (attempt.operation !== undefined) {
    return readFastForward(cfg, number, state, withinDeadline);
  }
  const view = viewForLand(cfg, attempt.pr);
  if (view.headRefName !== attempt.branch || view.state !== "MERGED") {
    throw new OpsError("same source PR is not genuinely MERGED yet");
  }
  const result = FULL_SHA.parse(view.mergeCommit?.oid);
  FULL_SHA.parse(view.headRefOid);
  const codeMerged = { pr: attempt.pr, sha: result };
  if (
    state.codeLanded !== null &&
    JSON.stringify(state.codeLanded) !== JSON.stringify(codeMerged)
  ) {
    throw new OpsError("observed merge differs from retained landed-code fact");
  }
  // Retain genuine landed truth even when it cannot establish own provenance.
  const observed = { ...state, codeMerged };
  writeState(cfg, number, observed);
  if (attempt.result === null) {
    return {
      landed: true,
      byHand: true,
      mergeCommit: result,
      headSha: view.headRefOid,
    };
  }
  confirmAuthorization(state, attempt);
  if (
    result !== attempt.result ||
    view.headRefOid !== attempt.authorized.code
  ) {
    throw new OpsError(
      "PR result or retained head differs from the saved HTTP 201 response and authorized head",
    );
  }
  const wt = paths.worktree(cfg, number);
  confirmLanded(cfg, number, { wt, codeMerged });
  landedParent(wt, result, view.headRefOid, true);
  const current = currentRevision(cfg, number, observed);
  if (
    current.pr?.state !== "MERGED" ||
    current.pr.number !== attempt.pr ||
    current.pr.headSha !== attempt.authorized.code ||
    current.pr.mergeCommit !== result ||
    current.revision.inputs !== attempt.authorized.inputs ||
    legacyWikiOf(current.revision) !== legacyWikiOf(attempt.authorized)
  ) {
    throw new OpsError(
      "PR, trusted inputs or legacy wiki head no longer match the original authorization",
    );
  }
  if (!withinDeadline()) {
    throw new OpsError("confirmation deadline reached during evidence reads");
  }
  saveReceipt(cfg, number, observed, { ...attempt.authorized, code: result });
  return { landed: true, mergeCommit: result, headSha: view.headRefOid };
}

// A deadline bounds this invocation only. Later caller-authorized runs may
// confirm the same saved response, but never renew mutation authority. The
// cumulative read count remains durable audit evidence, not a lifetime limit.
function reconcileAttemptedLand(
  cfg: Config,
  request: unknown,
  clock: ConfirmationClock = SYSTEM_CLOCK,
): RecoveryReply {
  const { number } = parseRequest(RECOVERY_REQUEST, "reconcile-land", request);
  const { deadlineSeconds, backoffSeconds } = cfg.landingConfirmation;
  const deadline = clock.now() + deadlineSeconds * MS_PER_SECOND;
  function withinDeadline(): boolean {
    return clock.now() < deadline;
  }
  let detail = "confirmation deadline reached";
  let waitIndex = 0;
  while (withinDeadline()) {
    try {
      const state = readWriteState(cfg, number);
      const attempt = boundAttempt(cfg, number, state);
      const spent = {
        ...state,
        landingAttempt: { ...attempt, reads: attempt.reads + 1 },
      };
      writeState(cfg, number, spent);
      if (
        readWriteState(cfg, number).landingAttempt?.reads !==
        spent.landingAttempt.reads
      ) {
        throw new OpsError("reconciliation read checkpoint is not confirmed");
      }
      return readEvidence(cfg, number, spent, withinDeadline);
    } catch (error) {
      if (error instanceof Error) {
        detail = error.message;
      }
    }
    const seconds = backoffSeconds[waitIndex];
    // Config validation guarantees a nonempty schedule. Repeat its final wait.
    if (seconds === undefined) {
      throw new OpsError("missing confirmation backoff schedule");
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      break;
    }
    clock.sleep(Math.min(seconds * MS_PER_SECOND, remaining));
    waitIndex = Math.min(waitIndex + 1, backoffSeconds.length - 1);
  }
  return diagnostic(
    `confirmation deadline reached (${deadlineSeconds}s); ${detail}`,
  );
}

export type { ConfirmationClock, RecoveryReply };
export { diagnostic, reconcileAttemptedLand };
