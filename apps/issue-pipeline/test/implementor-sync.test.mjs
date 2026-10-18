// @ts-check
// The implementor's start sync: a rebase stopped on conflicts gets resolver
// sessions of the same implementor, each counted and saved at once against
// `maxConflictFixes`, with no attempt past it; a rejected resolution rebases
// afresh; a transient resolver aborts the rebase and defers, counting
// nothing; the wiki side goes through wiki-sync and finish-wiki-sync.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertTemporaryRoot,
  BASE,
  DONE,
  fakeContext,
  ISSUE,
  opNames,
} from "./implementor-test-kit.mjs";

const { implementorRole } = await import(
  "../src/roles/implementor/implementor.ts"
);

const CONFLICT = {
  changed: false,
  conflict: true,
  inRebase: true,
  conflicts: ["src/a.ts"],
  baseSha: BASE,
};
const CLEAN = { changed: false, conflict: false, headSha: BASE };
const RESOLVED = {
  ok: true,
  reply: { outcome: "conflict-resolved", summary: "kept both" },
};
const REJECTED = { resolved: false, reason: "conflict markers remain" };

/**
 * @param {{ name: string, payload: Record<string, unknown> }[]} ops
 * @param {string} name
 */
function payloadsOf(ops, name) {
  return ops.filter((call) => call.name === name).map((call) => call.payload);
}

test("the tests run under a temporary pipeline root", () => {
  assertTemporaryRoot();
});

test("a conflict is resolved by a counted resolver session, then the work runs", async () => {
  const { ctx, ops, sessions, saves } = fakeContext({
    ops: { "sync-base": [CONFLICT] },
    sessions: [RESOLVED, DONE],
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 2);
  const task = sessions[0]?.task ?? "";
  assert.match(task, /- src\/a\.ts/u);
  assert.match(task, /git -C repo add -- <file>/u);
  assert.match(task, /GIT_EDITOR=true git -C repo rebase --continue/u);
  assert.match(task, /attempt 1 of 2/u);
  assert.equal(sessions[0]?.agent, "issue-pipeline-implementor");
  assert.equal(sessions[0]?.commits, true);
  assert.deepEqual(payloadsOf(ops, "finish-sync"), [
    { number: ISSUE, baseSha: BASE },
  ]);
  assert.deepEqual(
    saves.map((state) => state.counts.conflictFixes),
    [1],
  );
  assert.ok(end.kind === "next");
  assert.equal(end.state.counts.conflictFixes, 1);
});

test("rejected resolutions rebase afresh, up to exactly maxConflictFixes attempts", async () => {
  const { ctx, ops, sessions, saves } = fakeContext({
    ops: { "sync-base": [CONFLICT], "finish-sync": [REJECTED] },
    sessions: [RESOLVED],
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 2);
  assert.match(sessions[1]?.task ?? "", /rejected the last resolution[\s\S]*conflict markers remain/u);
  assert.match(sessions[1]?.task ?? "", /attempt 2 of 2/u);
  assert.equal(payloadsOf(ops, "sync-base").length, 3);
  // The two finishes that checked, then the abort before the stop.
  const finishes = payloadsOf(ops, "finish-sync");
  assert.equal(finishes.length, 3);
  assert.equal(finishes[2]?.["abort"], true);
  assert.deepEqual(
    saves.map((state) => state.counts.conflictFixes),
    [1, 2],
  );
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "conflict");
  assert.match(end.reason, /2 attempts \(maxConflictFixes\).*conflict markers remain/u);
  assert.equal(end.state.counts.conflictFixes, 2);
});

test("an issue out of conflict attempts stops before another resolver session", async () => {
  const { ctx, ops, sessions } = fakeContext({
    state: { counts: { conflictFixes: 2, syncs: 0 } },
    ops: { "sync-base": [CONFLICT] },
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 0);
  assert.deepEqual(payloadsOf(ops, "finish-sync")[0]?.["abort"], true);
  assert.ok(end.kind === "stop" && end.code === "conflict");
});

test("a transient resolver aborts the rebase and defers, counting nothing", async () => {
  const { ctx, ops, saves } = fakeContext({
    ops: { "sync-base": [CONFLICT] },
    sessions: [{ ok: false, transient: true, error: "ECONNRESET" }],
  });
  const end = await implementorRole(ctx);
  assert.deepEqual(end, { kind: "deferred", error: "ECONNRESET" });
  assert.equal(saves.length, 0);
  assert.equal(payloadsOf(ops, "finish-sync")[0]?.["abort"], true);
  assert.ok(!opNames(ops).includes("verify"));
});

test("cannot-fix is a counted attempt that aborts, and the next attempt rebases afresh", async () => {
  const { ctx, ops, sessions } = fakeContext({
    ops: { "sync-base": [CONFLICT, CONFLICT, CLEAN] },
    sessions: [
      { ok: true, reply: { outcome: "cannot-fix", summary: "too tangled" } },
      RESOLVED,
      DONE,
    ],
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 3);
  const finishes = payloadsOf(ops, "finish-sync");
  assert.equal(finishes[0]?.["abort"], true);
  assert.match(String(finishes[0]?.["reason"]), /too tangled/u);
  assert.deepEqual(finishes[1], { number: ISSUE, baseSha: BASE });
  assert.ok(end.kind === "next");
  assert.equal(end.state.counts.conflictFixes, 2);
});

test("a conflict reported with no stopped rebase stops with error", async () => {
  const { ctx, sessions } = fakeContext({
    ops: { "sync-base": [{ ...CONFLICT, inRebase: false }] },
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 0);
  assert.ok(end.kind === "stop" && end.code === "error");
});

test("a wiki conflict is resolved in docs/ through the wiki's own sync ops", async () => {
  const { ctx, ops, sessions } = fakeContext({
    ops: { "wiki-sync": [{ ...CONFLICT, conflicts: ["Chats.md"], branch: "master" }] },
    sessions: [RESOLVED, DONE],
  });
  const end = await implementorRole(ctx);
  const task = sessions[0]?.task ?? "";
  assert.match(task, /GIT_EDITOR=true git -C docs rebase --continue/u);
  assert.match(task, /- Chats\.md/u);
  assert.deepEqual(payloadsOf(ops, "finish-wiki-sync"), [{ number: ISSUE }]);
  assert.equal(payloadsOf(ops, "finish-sync").length, 0);
  assert.ok(end.kind === "next");
});
