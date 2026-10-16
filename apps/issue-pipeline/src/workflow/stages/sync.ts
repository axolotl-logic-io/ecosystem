// Sync: rebases the PR branch onto the base branch. A clean rebase moves to
// checks; a conflicting one is resolved by a writer while the issue has
// conflict attempts left, and then goes through every check
// again. Either way the rebase's flows are saved and acted on (flow-step.ts).

import { noteEvent } from "../event-log.ts";
import type { Signature } from "../signing.ts";
import { byStep } from "../signing.ts";
import type { IssueState } from "../types.ts";
import { syncReplyOf } from "./checks-reply.ts";
import { conflicted, maxConflictFixes } from "./conflict-resolver.ts";
import type { ConflictTarget } from "./conflict-target.ts";
import { flowEnd, prFlowed } from "./flow-step.ts";
import { opFailedStep } from "./network.ts";
import { branchPayload, stackedOnOf, syncOnto } from "./stacked.ts";
import { launchStep, onlyReply, stopStep } from "./step.ts";
import { finished, resolved } from "./sync-conflict.ts";
import type {
  LaunchResult,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// Where sync is: about to rebase, reading the rebase, waiting for the
// conflict resolver, waiting for the rebase to finish, or reading the PR's
// close or reopen.
type SyncPhase = "begin" | "synced" | "resolved" | "finished" | "flowed";

const PHASES: readonly SyncPhase[] = [
  "begin",
  "synced",
  "resolved",
  "finished",
  "flowed",
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
// has conflict attempts left. A stacked issue rebases onto its prerequisite's
// branch, or onto the base once that has merged (sync-base decides).
function begin(state: StageState, ctx: StageContext): Step {
  const keepConflict = (state.st.conflictFixes ?? 0) < maxConflictFixes(ctx);
  const payload = branchPayload(state, { keepConflict });
  return launchStep({ ...state, phase: "synced" }, [
    { kind: "op", name: "sync", op: "sync-base", payload },
  ]);
}

// A clean rebase moves to checks. A clean rebase of a head that passed every
// check, acceptance and the security review only re-runs the tests (Autumn,
// 2026-10-14): the change itself is the same. A stacked issue's reply says
// what it is stacked on now.
function clean(
  state: StageState,
  ctx: StageContext,
  reply: Readonly<Record<string, unknown>>,
  { changed, headSha }: { changed: boolean; headSha: string },
): Step {
  const { baseBranch, maxSyncs } = ctx.cfg;
  const st: IssueState = { ...state.st };
  const stackedOn = stackedOnOf(reply);
  if (stackedOn !== undefined) {
    st.stackedOn = stackedOn;
  }
  const onto = syncOnto(stackedOn, baseBranch);
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
    noteEvent(st, `rebased onto ${onto}${note}`, ctx.now());
    comments.push(
      prComment(
        byStep("sync"),
        `Rebased onto ${onto} without conflicts; the head is now ${headSha.slice(0, SHORT_SHA)}. ${then}`,
      ),
    );
  }
  st.headSha = headSha;
  st.stage = "checks";
  return flowEnd({ ...state, st }, ctx, reply, comments);
}

function synced(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const raw = onlyReply(results);
  const reply = syncReplyOf(raw);
  const base = ctx.cfg.baseBranch;
  if (reply.kind === "failed") {
    const reason = `could not sync with ${base}`;
    const failed = { op: "sync-base", reason, error: reply.error };
    return opFailedStep(state, failed, ctx.now());
  }
  if (reply.kind === "clean") {
    return clean(state, ctx, raw, reply);
  }
  if (reply.inRebase) {
    const { conflicts: files, baseSha } = reply;
    const stackedOn = stackedOnOf(raw);
    let target: ConflictTarget = { kind: "code" };
    if (stackedOn !== undefined) {
      target = { kind: "code", stackedOn };
    }
    return conflicted(state, ctx, { files, baseSha, target });
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
      return resolved(state, ctx, results);
    case "finished":
      return finished(state, ctx, results);
    case "flowed":
      return prFlowed(state, ctx, results);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
