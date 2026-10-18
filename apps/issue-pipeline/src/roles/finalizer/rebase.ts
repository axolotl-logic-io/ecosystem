// The finalizer's rebase before the merge (#422): a branch that doesn't
// contain its target's head (the base, or a stacked prerequisite's head, as
// src/stack.ts decides) is rebased with sync-base once the merge gate and
// the merge-order wait have passed, so only the issue at the head of the
// merge queue rebases. sync-base pushes a clean rebase itself. A clean
// rebase counts toward maxSyncs and has its tests run again (retest.ts); a
// conflicting one is aborted and saved at `sync` with the passed head kept,
// so the implementor's conflict resolver runs and the issue goes through
// checks, acceptance and security again. Pure.

import { byStep } from "../../workflow/signing.ts";
import { isRecord, syncReplyOf } from "../../workflow/stages/checks-reply.ts";
import {
  stackedOnOf,
  stackFields,
  syncOnto,
} from "../../workflow/stages/stacked.ts";
import type { Effect } from "../machine.ts";
import type { LinearStep } from "../walk.ts";
import { ended, noted, opFailed, stoppedFor } from "./ends.ts";
import type { FinalizerData, PrComment } from "./locate.ts";

const SHORT_SHA = 12;

// `data` with the merge deferred for `reason` and the rebase due: the
// verified head it rebases is saved as a checkpoint before sync-base runs.
function rebaseDue(data: FinalizerData, reason: string): FinalizerData {
  const note = `merge deferred: ${reason}; rebasing now`;
  return { ...noted(data, note), retest: "rebase", rebaseOf: data.verifiedSha };
}

function rebaseEffect(data: FinalizerData): Effect {
  const fields = { keepConflict: false, ...stackFields(data.stackedOn) };
  return {
    kind: "op",
    op: "sync-base",
    payload: { number: data.issue, ...fields },
  };
}

// `data` sent back to `sync` with its passed head kept, noting `note`.
function backToSync(data: FinalizerData, note: string): FinalizerData {
  const back: FinalizerData = {
    ...noted(data, note),
    passedSha: data.verifiedSha,
    testsOnly: false,
    rebaseOf: null,
    retest: "none",
  };
  return ended(back, { kind: "saved", stage: "sync" });
}

// The PR comment a clean rebase posts with the retest's first op.
function rebasedComment(
  data: FinalizerData,
  onto: string,
  headSha: string,
): PrComment {
  return {
    number: data.st.pr ?? data.issue,
    by: byStep("sync"),
    body: `Rebased onto ${onto} without conflicts; the head is now ${headSha.slice(0, SHORT_SHA)}. This head already passed every check before the rebase, so only the tests run again before merge.`,
    key: `merge-rebase-${headSha.slice(0, SHORT_SHA)}`,
  };
}

// A rebase that moved the branch: counted toward maxSyncs, then retested.
// A rebase that left no code change goes to `sync`, whose flow step handles
// it.
function moved(
  data: FinalizerData,
  raw: Readonly<Record<string, unknown>>,
  headSha: string,
): FinalizerData {
  const { baseBranch, maxSyncs } = data.settings.cfg;
  const syncs = data.syncs + 1;
  const counted = { ...data, syncs, headSha, rebaseOf: null };
  if (syncs > maxSyncs) {
    const reason = `${baseBranch} kept moving; rebased ${maxSyncs} times without merging`;
    return stoppedFor(counted, reason, null);
  }
  const onto = syncOnto(data.stackedOn, baseBranch);
  const { codeChanged } = raw;
  if (codeChanged === false) {
    return backToSync(counted, `rebased onto ${onto}; no code change is left`);
  }
  const retested: FinalizerData = {
    ...noted(counted, `rebased onto ${onto}; re-running only the tests`),
    testsOnly: true,
    passedSha: null,
    retest: "verify",
    comments: [...data.comments, rebasedComment(data, onto, headSha)],
  };
  return retested;
}

// A clean rebase: a head that didn't move (the branch already held its
// target's head) goes straight to the merge; a moved one to its retest.
// A stacked branch's reply says what it is stacked on now.
function clean(
  data: FinalizerData,
  raw: Readonly<Record<string, unknown>>,
  headSha: string,
): FinalizerData {
  const stackedOn = stackedOnOf(raw);
  let next = data;
  if (stackedOn !== undefined) {
    next = { ...data, stackedOn };
  }
  if (headSha === data.rebaseOf) {
    return { ...next, rebaseOf: null, retest: "merge" };
  }
  return moved(next, raw, headSha);
}

function rebased(data: FinalizerData, raw: unknown): FinalizerData {
  const base = data.settings.cfg.baseBranch;
  let record: Readonly<Record<string, unknown>> = {};
  if (isRecord(raw)) {
    record = raw;
  }
  const reply = syncReplyOf(record);
  switch (reply.kind) {
    case "failed":
      return opFailed(
        data,
        "sync-base",
        `could not sync with ${base}`,
        reply.error ?? "the sync-base reply is unreadable",
      );
    case "conflict": {
      const onto = syncOnto(data.stackedOn, base);
      const note = `rebasing onto ${onto} conflicts; the conflict resolver runs at sync`;
      return backToSync(data, note);
    }
    case "clean":
      return clean(data, record, reply.headSha);
    default: {
      const unhandled: never = reply;
      return unhandled;
    }
  }
}

const rebaseStep: LinearStep<FinalizerData> = {
  name: "rebase",
  kind: "script",
  skip: (data: FinalizerData): boolean =>
    data.end !== null || data.retest !== "rebase",
  effect: rebaseEffect,
  apply: rebased,
  recover: (data: FinalizerData, error: string): FinalizerData =>
    opFailed(data, "sync-base", "could not sync with the base", error),
};

export { rebaseDue, rebaseStep };
