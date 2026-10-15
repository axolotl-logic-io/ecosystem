// Sync's step machine (src/workflow/stages/sync.ts), driven directly with
// recorded replies and a fixed clock. The trace tests run it through the
// sweep; these pin each outcome's step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CIFIX_SCHEMA } from "../src/workflow/schemas.ts";
import { next } from "../src/workflow/stages/sync.ts";
import {
  after,
  CTX,
  MODELS,
  replied,
  STAMP,
  sessionResult,
  signedAs,
  stateAt,
  stepComment,
} from "./workflow-checks-test-kit.mjs";

const HEAD = "dddddddddddddddd";
const FIXER_TOKENS = 100_000;
const CONFLICT = {
  ok: true,
  conflict: true,
  inRebase: true,
  conflicts: ["src/a.ts"],
};
const FILE_LIST = "Conflicting files:\nsrc/a.ts";
const KEPT_BOTH = { status: "fixed", summary: "Kept both changes." };
const TESTS_ONLY_NOTE = /only the tests run again before merge/u;
const ATTEMPT_LINE = /conflict resolver, attempt 1 of 2/u;
// The conflict reply has no baseSha, so the task names none.
const NO_BASE_SHA = /\(undefined\), and the rebase stopped/u;

// Sync's step after its rebase replies with `reply`.
function synced(reply, fields = {}) {
  return replied(next, next(stateAt("sync", fields), CTX, []), reply);
}

// Sync's step after the resolver of a conflicting rebase returns `result`.
function resolvedWith(result, fields = {}) {
  return after(next, synced(CONFLICT, fields), CTX, result);
}

test("a clean rebase launches sync-base, then moves to checks", () => {
  const begun = next(stateAt("sync"), CTX, []);
  assert.deepEqual(begun.launches, [
    {
      kind: "op",
      name: "sync",
      op: "sync-base",
      payload: { number: 7, keepConflict: true },
    },
  ]);
  assert.deepEqual(Object.keys(begun.launches[0].payload), [
    "number",
    "keepConflict",
  ]);
  const step = replied(next, begun, { ok: true, changed: true, headSha: HEAD });
  assert.equal(step.done, true);
  assert.equal(step.stop, null);
  assert.equal(step.state.st.stage, "checks");
  assert.equal(step.state.st.headSha, HEAD);
  assert.equal(step.state.st.syncs, 1);
  assert.equal(step.state.st.testsOnly, false);
  assert.equal(step.state.st.passedSha, null);
  assert.deepEqual(step.state.st.log, [`${STAMP} rebased onto integration`]);
  assert.deepEqual(step.comments, [
    stepComment(
      "sync",
      "Rebased onto integration without conflicts; the head is now dddddddddddd. Rebases aren't re-reviewed; the checks run again.",
    ),
  ]);
});

test("a clean rebase of a head that passed everything re-runs only the tests", () => {
  const step = synced(
    { ok: true, changed: true, headSha: HEAD },
    { passedSha: "cccccccccccccccc" },
  );
  assert.equal(step.state.st.testsOnly, true);
  assert.equal(step.state.st.passedSha, null);
  assert.match(step.comments[0].body, TESTS_ONLY_NOTE);
});

test("an unchanged head moves to checks without a comment", () => {
  const step = synced({ ok: true, changed: false, headSha: HEAD });
  assert.deepEqual([step.state.st.stage, step.state.st.syncs], ["checks", 0]);
  assert.deepEqual(step.comments, []);
});

test("a base that kept moving stops after the last sync", () => {
  const step = synced({ ok: true, changed: true, headSha: HEAD }, { syncs: 3 });
  assert.deepEqual(step.stop, {
    reason: "integration kept moving; rebased 3 times without merging",
    detail: null,
    code: null,
  });
});

test("a conflict is resolved by a writer, then the rebase is finished", () => {
  const conflicted = synced(CONFLICT);
  const [launch] = conflicted.launches;
  assert.deepEqual(
    { ...launch, task: "" },
    {
      kind: "child",
      name: "conflicts-1",
      label: "Resolve rebase conflicts for issue 7",
      agent: "issue-pipeline-writer",
      model: MODELS.fixer,
      schema: CIFIX_SCHEMA,
      writer: true,
      minutes: 45,
      task: "",
    },
  );
  assert.match(launch.task, ATTEMPT_LINE);
  assert.match(launch.task, NO_BASE_SHA);
  assert.equal(conflicted.state.st.allocated, FIXER_TOKENS);
  assert.deepEqual(conflicted.state.st.sessions, ["fixer"]);
  assert.equal(conflicted.state.st.conflictFixes, 1);
  const resolver = sessionResult("conflicts-1", KEPT_BOTH);
  const finishing = after(next, conflicted, CTX, resolver);
  assert.deepEqual(finishing.launches, [
    {
      kind: "op",
      name: "finish-sync",
      op: "finish-sync",
      payload: { number: 7, abort: false, reason: "Kept both changes." },
    },
  ]);
  assert.deepEqual(finishing.comments, []);
  const step = replied(next, finishing, {
    ok: true,
    resolved: true,
    headSha: HEAD,
  });
  assert.deepEqual([step.done, step.stop], [true, null]);
  assert.deepEqual([step.state.st.stage, step.state.st.syncs], ["checks", 1]);
  assert.deepEqual(step.comments, [
    {
      by: { ...signedAs("conflicts-1"), role: "conflict resolver (attempt 1)" },
      body: "Kept both changes.",
      where: "pr",
    },
    stepComment(
      "sync",
      "Rebased onto integration after resolving conflicts in `src/a.ts`; the head is now dddddddddddd. Every check runs again on it.",
    ),
  ]);
});

test("used-up conflict fixes leave the rebase aborted and stop on conflicts", () => {
  const begun = next(stateAt("sync", { conflictFixes: 2 }), CTX, []);
  assert.equal(begun.launches[0].payload.keepConflict, false);
  const step = replied(next, begun, { ...CONFLICT, inRebase: false });
  assert.deepEqual(step.stop, {
    reason: "rebasing onto integration conflicts again after 2 resolutions",
    detail: FILE_LIST,
    code: null,
  });
});

test("a rejected resolution stops on the last attempt and retries before it", () => {
  const resolver = sessionResult("conflicts-2", KEPT_BOTH);
  const rejection = { ok: true, resolved: false, reason: "Tests fail." };
  const last = replied(
    next,
    resolvedWith(resolver, { conflictFixes: 1 }),
    rejection,
  );
  assert.deepEqual(last.stop, {
    reason: "the conflict resolution was rejected",
    detail: `${FILE_LIST}\n\nTests fail.`,
    code: null,
  });
  assert.equal(last.comments.length, 1);
  const first = replied(next, resolvedWith(resolver), rejection);
  assert.deepEqual([first.stop, first.state.st.stage], [null, "sync"]);
  assert.deepEqual(first.state.st.log, [
    `${STAMP} conflict resolution rejected: Tests fail.; will retry next sweep`,
  ]);
});

test("a resolver that can't fix the conflicts leaves the issue at sync", () => {
  const resolver = sessionResult("conflicts-1", {
    status: "cannot-fix",
    summary: "Both sides rewrote a.ts.",
  });
  const finishing = resolvedWith(resolver);
  assert.equal(finishing.launches[0].payload.abort, true);
  const step = replied(next, finishing, {
    ok: true,
    resolved: false,
    reason: "aborted",
  });
  assert.deepEqual([step.done, step.stop], [true, null]);
  assert.equal(step.state.st.stage, "sync");
  assert.equal(
    step.comments[0].body,
    "I couldn't resolve the conflicts with integration: Both sides rewrote a.ts.",
  );
});

test("a failed resolver session aborts the rebase and stops", () => {
  const finishing = resolvedWith({
    ...sessionResult("conflicts-1", null),
    ok: false,
    error: "timed out",
  });
  assert.deepEqual(finishing.launches[0].payload, {
    number: 7,
    abort: true,
    reason: "the conflict resolver failed",
  });
  const step = replied(next, finishing, { ok: true, resolved: false });
  assert.deepEqual(step.stop, {
    reason: "the conflict-resolver session failed",
    detail: `${FILE_LIST}\n\ntimed out`,
    code: null,
  });
  assert.deepEqual(step.comments, []);
});
