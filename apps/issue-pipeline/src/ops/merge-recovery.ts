// Durable uncertainty and bounded read-only recovery of a single branch POST.
// Only a saved successful response can become an own receipt; PR truth alone
// is external provenance. No path in this module mutates code or opens a writer.
import { z } from "zod";
import { assignedBranch } from "../branch-binding.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { legacyWikiOf } from "../merge-provenance.ts";
import { recordedAuthorization } from "../merged-authorization.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest, sleepMs } from "../process.ts";
import { confirmMerged, currentRevision } from "../revision.ts";
import { readWriteState, writeState } from "../saved-state.ts";
import { candidateRefusal } from "../security-clearance.ts";
import type { IssueState, MergeAttempt, Revision } from "../state.ts";
import { approvalHolds, sameRevision } from "../state.ts";
import { FULL_SHA, mergedParent } from "./merged-graph.ts";
import { viewForMerge } from "./pr-merge.ts";

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
  | { merged: true; mergeCommit: string; headSha: string; byHand?: true }
  | { merged: false; reason: string };

function diagnostic(detail: string): RecoveryReply {
  return {
    merged: false,
    reason: `bounded merge recovery: code may already have landed; another merge POST or code writer is not authorized; retain recovery evidence: ${detail}`,
  };
}

// Confirm the pre-POST checkpoint is actually readable before sending code.
function beginMerge(
  cfg: Config,
  number: number,
  pr: number,
  authorized: Revision,
): IssueState {
  const state = readWriteState(cfg, number);
  const current = currentRevision(cfg, number, state);
  if (
    state.mergeAttempt !== null ||
    state.codeMerged !== null ||
    (state.merged !== null && state.merged.code !== null) ||
    (state.security !== null && state.security.finding !== null) ||
    state.pr !== pr ||
    state.hardened === null ||
    !sameRevision(current.revision, authorized) ||
    !approvalHolds(state, authorized) ||
    candidateRefusal(state, authorized, {
      target: cfg.baseBranch,
      baseSha: current.baseSha,
    }) !== undefined
  ) {
    throw new OpsError("merge has no fresh unattempted saved authorization");
  }
  const attempt: MergeAttempt = {
    repo: cfg.repo,
    pr: state.pr,
    target: cfg.baseBranch,
    branch: assignedBranch(cfg, number, state),
    authorized,
    hardened: state.hardened,
    integration: state.integration,
    result: null,
    reads: 0,
  };
  writeState(cfg, number, { ...state, mergeAttempt: attempt });
  const saved = readWriteState(cfg, number);
  if (JSON.stringify(saved.mergeAttempt) !== JSON.stringify(attempt)) {
    throw new OpsError(
      "merge attempt checkpoint is not confirmed; do not send a merge POST",
    );
  }
  return saved;
}

function saveMergeResponse(cfg: Config, number: number, result: string): void {
  FULL_SHA.parse(result);
  const state = readWriteState(cfg, number);
  if (state.mergeAttempt === null || state.mergeAttempt.result !== null) {
    throw new OpsError("successful response has no unique attempted merge");
  }
  const attempt = { ...state.mergeAttempt, result };
  writeState(cfg, number, { ...state, mergeAttempt: attempt });
  if (
    JSON.stringify(readWriteState(cfg, number).mergeAttempt) !==
    JSON.stringify(attempt)
  ) {
    throw new OpsError("successful response checkpoint is not confirmed");
  }
}

function boundAttempt(
  cfg: Config,
  number: number,
  state: IssueState,
): MergeAttempt {
  const attempt = state.mergeAttempt;
  if (
    attempt === null ||
    attempt.repo !== cfg.repo ||
    attempt.pr !== state.pr ||
    attempt.target !== cfg.baseBranch ||
    attempt.branch !== assignedBranch(cfg, number, state) ||
    attempt.authorized.code === null
  ) {
    throw new OpsError(
      "attempt identity or original hardening/integration authorization changed",
    );
  }
  return attempt;
}

function confirmAuthorization(state: IssueState, attempt: MergeAttempt): void {
  if (
    !sameRevision(
      recordedAuthorization(state) ?? { code: null, inputs: "" },
      attempt.authorized,
    ) ||
    state.hardened === null ||
    !sameRevision(state.hardened, attempt.hardened) ||
    JSON.stringify(state.integration) !== JSON.stringify(attempt.integration)
  ) {
    throw new OpsError("original hardening/integration authorization changed");
  }
}

function saveReceipt(
  cfg: Config,
  number: number,
  state: IssueState,
  merged: Revision,
): void {
  writeState(cfg, number, { ...state, merged });
  const saved = readWriteState(cfg, number);
  if (saved.merged === null || !sameRevision(saved.merged, merged)) {
    throw new OpsError("own-merge receipt save is not confirmed");
  }
}

function readEvidence(
  cfg: Config,
  number: number,
  state: IssueState,
  withinDeadline: () => boolean,
): RecoveryReply {
  const attempt = boundAttempt(cfg, number, state);
  const view = viewForMerge(cfg, attempt.pr);
  if (view.headRefName !== attempt.branch || view.state !== "MERGED") {
    throw new OpsError("same source PR is not genuinely MERGED yet");
  }
  const result = FULL_SHA.parse(view.mergeCommit?.oid);
  FULL_SHA.parse(view.headRefOid);
  const codeMerged = { pr: attempt.pr, sha: result };
  if (
    state.codeMerged !== null &&
    JSON.stringify(state.codeMerged) !== JSON.stringify(codeMerged)
  ) {
    throw new OpsError("observed merge differs from retained landed-code fact");
  }
  // Retain genuine landed truth even when it cannot establish own provenance.
  const observed = { ...state, codeMerged };
  writeState(cfg, number, observed);
  if (attempt.result === null) {
    return {
      merged: true,
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
  confirmMerged(cfg, number, { wt, codeMerged });
  mergedParent(wt, result, view.headRefOid, true);
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
  return { merged: true, mergeCommit: result, headSha: view.headRefOid };
}

// A deadline bounds this invocation only. Later caller-authorized runs may
// confirm the same saved response, but never renew mutation authority. The
// cumulative read count remains durable audit evidence, not a lifetime limit.
function reconcileMerge(
  cfg: Config,
  request: unknown,
  clock: ConfirmationClock = SYSTEM_CLOCK,
): RecoveryReply {
  const { number } = parseRequest(RECOVERY_REQUEST, "reconcile-merge", request);
  const { deadlineSeconds, backoffSeconds } = cfg.mergeConfirmation;
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
        mergeAttempt: { ...attempt, reads: attempt.reads + 1 },
      };
      writeState(cfg, number, spent);
      if (
        readWriteState(cfg, number).mergeAttempt?.reads !==
        spent.mergeAttempt.reads
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

export type { ConfirmationClock };
export { beginMerge, diagnostic, reconcileMerge, saveMergeResponse };
