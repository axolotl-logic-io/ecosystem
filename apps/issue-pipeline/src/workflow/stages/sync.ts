// Sync: rebases the PR branch onto the base branch. A clean rebase moves to
// checks; a conflicting one is resolved by a writer while the issue has
// conflict attempts and rebase budget left, and then goes through every check
// again.

import { chargeCheck } from "../budget.ts";
import { noteEvent } from "../event-log.ts";
import type { Signature } from "../signing.ts";
import { byStep } from "../signing.ts";
import type { IssueState } from "../types.ts";
import { syncReplyOf } from "./checks-reply.ts";
import { CODE_TARGET } from "./conflict-target.ts";
import { opFailedStep } from "./network.ts";
import { doneStep, launchStep, onlyReply, stopStep } from "./step.ts";
import {
  conflicted,
  finished,
  maxConflictFixes,
  resolved,
} from "./sync-conflict.ts";
import type {
  LaunchResult,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// Where sync is: about to rebase, reading the rebase, waiting for the
// conflict resolver, or waiting for the rebase to finish.
type SyncPhase = "begin" | "synced" | "resolved" | "finished";

const PHASES: readonly SyncPhase[] = [
  "begin",
  "synced",
  "resolved",
  "finished",
];

const SHORT_SHA = 12;

function phaseOf(state: StageState): SyncPhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`sync: unknown phase ${state.phase}`);
  }
  return phase;
}

function prComment(by: Signature, body: string): StageComment {
  return { by, body, where: "pr" };
}

// Rebases, leaving a conflicting rebase stopped for a resolver while the issue
// has conflict attempts and rebase budget for one left. An issue the merge
// stage sent back is re-checking from here on, so its sessions are charged to
// the rebase pool.
function begin(state: StageState, ctx: StageContext): Step {
  const st: IssueState = { ...state.st };
  if (typeof st.passedSha === "string" && st.passedSha !== "") {
    st.rechecking = true;
  }
  const keepConflict =
    (st.conflictFixes ?? 0) < maxConflictFixes(ctx) &&
    chargeCheck(ctx.budgets, st, "fixer", "rebase").charged;
  const payload = { number: state.n, keepConflict };
  return launchStep({ ...state, st, phase: "synced" }, [
    { kind: "op", name: "sync", op: "sync-base", payload },
  ]);
}

// A clean rebase moves to checks. A clean rebase of a head that passed every
// check, acceptance and the security review only re-runs the tests (Autumn,
// 2026-10-14): the change itself is the same.
function clean(
  state: StageState,
  ctx: StageContext,
  changed: boolean,
  headSha: string,
): Step {
  const { baseBranch, maxSyncs } = ctx.cfg;
  const st: IssueState = { ...state.st };
  if (changed) {
    st.syncs = (st.syncs ?? 0) + 1;
    if (st.syncs > maxSyncs) {
      return stopStep(
        { ...state, st },
        `${baseBranch} kept moving; rebased ${maxSyncs} times without merging`,
        null,
      );
    }
  }
  const testsOnly =
    typeof st.passedSha === "string" &&
    st.passedSha !== "" &&
    st.passedSha === st.headSha;
  st.testsOnly = testsOnly;
  st.passedSha = null;
  const comments: StageComment[] = [];
  if (changed) {
    let note = "";
    let then = "Rebases aren't re-reviewed; the checks run again.";
    if (testsOnly) {
      note = "; re-running only the tests";
      then =
        "This head already passed every check before the rebase, so only the tests run again before merge.";
    }
    noteEvent(st, `rebased onto ${baseBranch}${note}`, ctx.now());
    comments.push(
      prComment(
        byStep("sync"),
        `Rebased onto ${baseBranch} without conflicts; the head is now ${headSha.slice(0, SHORT_SHA)}. ${then}`,
      ),
    );
  }
  st.headSha = headSha;
  st.stage = "checks";
  return doneStep({ ...state, st }, comments);
}
function synced(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const reply = syncReplyOf(onlyReply(results));
  const base = ctx.cfg.baseBranch;
  if (reply.kind === "failed") {
    const reason = `could not sync with ${base}`;
    const failed = { op: "sync-base", reason, error: reply.error };
    return opFailedStep(state, failed, ctx.now());
  }
  if (reply.kind === "clean") {
    return clean(state, ctx, reply.changed, reply.headSha);
  }
  if (reply.inRebase) {
    const { conflicts: files, baseSha } = reply;
    return conflicted(state, ctx, { files, baseSha, target: CODE_TARGET });
  }
  const files = `Conflicting files:\n${reply.conflicts.join("\n")}`;
  const max = maxConflictFixes(ctx);
  if ((state.st.conflictFixes ?? 0) >= max) {
    return stopStep(
      state,
      `rebasing onto ${base} conflicts again after ${max} resolutions`,
      files,
    );
  }
  // Attempts were left, so sync-base gave up the rebase because the resolver
  // didn't fit the rebase pool: a budget stop, not a resolver failure.
  const fixer = chargeCheck(ctx.budgets, state.st, "fixer", "rebase");
  if (!fixer.charged) {
    return stopStep(state, fixer.reason, `${fixer.detail}\n\n${files}`);
  }
  return stopStep(state, `rebasing onto ${base} conflicts`, files);
}
// Sync's next step, from its state and the results of its last launches.
function next(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const phase = phaseOf(state);
  switch (phase) {
    case "begin":
      return begin(state, ctx);
    case "synced":
      return synced(state, ctx, results);
    case "resolved":
      return resolved(state, results);
    case "finished":
      return finished(state, ctx, results);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
