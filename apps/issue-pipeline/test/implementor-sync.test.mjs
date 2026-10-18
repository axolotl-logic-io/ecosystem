// @ts-check
// The implementor's start sync: a rebase stopped on conflicts gets resolver
// sessions of the same implementor, each counted and saved at once against
// `maxConflictFixes`, with no attempt past it; a rejected resolution rebases
// afresh; a transient resolver aborts the rebase and defers, counting
// nothing; the wiki side goes through wiki-sync and finish-wiki-sync.
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import {
  BASE,
  DONE,
  fakeContext,
  ISSUE,
  opNames,
  ROOT,
  TEMPORARY_ROOT,
} from "./implementor-test-kit.mjs";

const { implementorRole } = await import(
  "../src/roles/implementor/implementor.ts"
);
const { OpsFailure } = await import("../src/job/role-context.ts");

const CONFLICT = {
  changed: false,
  conflict: true,
  inRebase: true,
  conflicts: ["src/a.ts"],
  baseSha: BASE,
};
const CLEAN = { changed: false, conflict: false, headSha: BASE };
/** @type {import("../src/job/role-context.ts").SessionResult} */
const RESOLVED = {
  ok: true,
  reply: { outcome: "conflict-resolved", summary: "kept both" },
};
const REJECTED = { resolved: false, reason: "conflict markers remain" };
// Two resolver sessions whose finishes are checked, then the abort before
// the stop: three rebases and three finishes.
const REJECTED_RUN_OPS = 3;
// A cannot-fix, a resolution and the work.
const CANNOT_FIX_RUN_SESSIONS = 3;

const CONFLICTED_FILE = /- src\/a\.ts/u;
const STAGE_COMMAND = /git -C repo add -- <file>/u;
const CONTINUE_COMMAND = /GIT_EDITOR=true git -C repo rebase --continue/u;
const FIRST_ATTEMPT = /attempt 1 of 2/u;
const SECOND_ATTEMPT = /attempt 2 of 2/u;
const REJECTION_SHOWN =
  /rejected the last resolution[\s\S]*conflict markers remain/u;
const OUT_OF_ATTEMPTS =
  /2 attempts \(maxConflictFixes\).*conflict markers remain/u;
const CANNOT_FIX_REASON = /too tangled/u;
const WIKI_CONTINUE_COMMAND = /GIT_EDITOR=true git -C docs rebase --continue/u;
const CONFLICTED_PAGE = /- Chats\.md/u;
const ONLY_THESE_COMMANDS =
  /only git commands you may run, and only for this rebase/u;
const NO_OTHER_COMMIT = /not leave to make any other commit/u;
const NO_SKIP =
  /Never skip, abort or reset the rebase, and never pass `--no-verify`/u;
const EVERY_STOP = /Repeat until the rebase finishes/u;
const FAILED_RESOLVER = /code conflict resolver session failed: no reply/u;
const WIKI_OUT_OF_ATTEMPTS =
  /wiki rebase still conflicts after the resolver's 0 attempts/u;

/**
 * @param {{ name: string, payload: Record<string, unknown> }[]} ops
 * @param {string} name
 */
function payloadsOf(ops, name) {
  return ops.filter((call) => call.name === name).map((call) => call.payload);
}

/**
 * The abort flag and reason of op `name`'s first call.
 * @param {{ name: string, payload: Record<string, unknown> }[]} ops
 * @param {string} name
 */
function firstFinish(ops, name) {
  const { abort, reason } = payloadsOf(ops, name)[0] ?? {};
  return { abort, reason };
}

test("the tests run under a temporary pipeline root", () => {
  assert.equal(ROOT, TEMPORARY_ROOT);
  assert.ok(TEMPORARY_ROOT.startsWith(os.tmpdir()));
});

test("a conflict is resolved by a counted resolver session, then the work runs", async () => {
  const { ctx, ops, sessions, saves } = fakeContext({
    ops: { "sync-base": [CONFLICT] },
    sessions: [RESOLVED, DONE],
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 2);
  const task = sessions[0]?.task ?? "";
  assert.match(task, CONFLICTED_FILE);
  assert.match(task, STAGE_COMMAND);
  assert.match(task, CONTINUE_COMMAND);
  assert.match(task, FIRST_ATTEMPT);
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
  assert.match(sessions[1]?.task ?? "", REJECTION_SHOWN);
  assert.match(sessions[1]?.task ?? "", SECOND_ATTEMPT);
  assert.equal(payloadsOf(ops, "sync-base").length, REJECTED_RUN_OPS);
  const finishes = payloadsOf(ops, "finish-sync");
  assert.equal(finishes.length, REJECTED_RUN_OPS);
  const { abort } = finishes.at(-1) ?? {};
  assert.equal(abort, true);
  assert.deepEqual(
    saves.map((state) => state.counts.conflictFixes),
    [1, 2],
  );
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "conflict");
  assert.match(end.reason, OUT_OF_ATTEMPTS);
  assert.equal(end.state.counts.conflictFixes, 2);
});

test("an issue out of conflict attempts stops before another resolver session", async () => {
  const { ctx, ops, sessions } = fakeContext({
    state: { counts: { conflictFixes: 2, syncs: 0 } },
    ops: { "sync-base": [CONFLICT] },
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 0);
  assert.equal(firstFinish(ops, "finish-sync").abort, true);
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
  assert.equal(firstFinish(ops, "finish-sync").abort, true);
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
  assert.equal(sessions.length, CANNOT_FIX_RUN_SESSIONS);
  const finishes = payloadsOf(ops, "finish-sync");
  const first = firstFinish(ops, "finish-sync");
  assert.equal(first.abort, true);
  assert.match(String(first.reason), CANNOT_FIX_REASON);
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
    ops: {
      "wiki-sync": [{ ...CONFLICT, conflicts: ["Chats.md"], branch: "master" }],
    },
    sessions: [RESOLVED, DONE],
  });
  const end = await implementorRole(ctx);
  const task = sessions[0]?.task ?? "";
  assert.match(task, WIKI_CONTINUE_COMMAND);
  assert.match(task, CONFLICTED_PAGE);
  assert.deepEqual(payloadsOf(ops, "finish-wiki-sync"), [{ number: ISSUE }]);
  assert.equal(payloadsOf(ops, "finish-sync").length, 0);
  assert.ok(end.kind === "next");
});

test("the resolver may only stage its files and continue the rebase, never commit or skip", async () => {
  const { ctx, sessions } = fakeContext({
    ops: { "sync-base": [CONFLICT] },
    sessions: [RESOLVED, DONE],
  });
  await implementorRole(ctx);
  const task = sessions[0]?.task ?? "";
  assert.match(task, ONLY_THESE_COMMANDS);
  assert.match(task, NO_OTHER_COMMIT);
  assert.match(task, NO_SKIP);
  assert.match(task, EVERY_STOP);
});

test("a failed resolver session aborts the rebase and stops with error, counting nothing", async () => {
  const { ctx, ops, saves } = fakeContext({
    ops: { "sync-base": [CONFLICT] },
    sessions: [{ ok: false, transient: false, error: "no reply" }],
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "error");
  assert.match(end.reason, FAILED_RESOLVER);
  assert.equal(saves.length, 0);
  assert.equal(end.state.counts.conflictFixes, 0);
  const finishes = payloadsOf(ops, "finish-sync");
  assert.equal(finishes.length, 1);
  assert.equal(firstFinish(ops, "finish-sync").abort, true);
  assert.ok(!opNames(ops).includes("verify"));
});

test("an abort that fails propagates its failure instead of deferring quietly", async () => {
  const failure = new OpsFailure("finish-sync", 1, "git rebase --abort failed");
  const { ctx } = fakeContext({
    ops: { "sync-base": [CONFLICT], "finish-sync": [failure] },
    sessions: [{ ok: false, transient: true, error: "ECONNRESET" }],
  });
  await assert.rejects(implementorRole(ctx), failure);
});

test("a stopped wiki rebase past maxConflictFixes aborts through finish-wiki-sync", async () => {
  const { ctx, ops, sessions } = fakeContext({
    config: { maxConflictFixes: 0 },
    ops: { "wiki-sync": [{ ...CONFLICT, conflicts: ["Chats.md"] }] },
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 0);
  const aborts = payloadsOf(ops, "finish-wiki-sync");
  assert.equal(aborts.length, 1);
  assert.equal(firstFinish(ops, "finish-wiki-sync").abort, true);
  assert.ok(end.kind === "stop" && end.code === "conflict");
  assert.match(end.reason, WIKI_OUT_OF_ATTEMPTS);
});
