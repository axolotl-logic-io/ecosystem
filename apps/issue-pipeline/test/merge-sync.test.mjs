// @ts-check
// The Reviewer's own sync at merge (src/roles/merge/sync.ts): a rebase
// stopped on conflicts gets Reviewer resolver sessions in the integration
// phase, each counted and saved at once against `maxConflictFixes`, with no
// attempt past it; a rejected resolution rebases afresh; a transient
// resolver aborts the rebase and defers, counting nothing; the wiki side
// goes through wiki-sync and finish-wiki-sync.
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import {
  BASE,
  fakeContext,
  ISSUE,
  opNames,
  ROOT,
  TEMPORARY_ROOT,
} from "./implementor-test-kit.mjs";

const { syncSide } = await import("../src/roles/merge/sync.ts");
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
// A cannot-fix and a resolution.
const CANNOT_FIX_RUN_SESSIONS = 2;

const CONFLICTED_FILE = /- src\/a\.ts/u;
const RESOLUTION_TASK = /Task: `conflict-resolution`/u;
const CODE_SIDE = /Side: code; the checkout is `repo\/`/u;
const WIKI_SIDE = /Side: wiki; the checkout is `docs\/`/u;
const FIRST_ATTEMPT = /Attempt: 1 of 2/u;
const SECOND_ATTEMPT = /Attempt: 2 of 2/u;
const REJECTION_SHOWN =
  /The last resolution was rejected[\s\S]*conflict markers remain/u;
const OUT_OF_ATTEMPTS =
  /2 attempts \(maxConflictFixes\).*conflict markers remain/u;
const CANNOT_FIX_REASON = /too tangled/u;
const CONFLICTED_PAGE = /- Chats\.md/u;
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

/**
 * The code or wiki side's sync from the context's state, within two
 * attempts unless `max` says otherwise.
 * @param {import("../src/job/role-context.ts").RoleContext} ctx
 * @param {"code" | "wiki"} [side] @param {number} [max]
 */
function sync(ctx, side = "code", max = 2) {
  return syncSide(ctx, ctx.state, { side, maxConflictFixes: max });
}

test("the tests run under a temporary pipeline root", () => {
  assert.equal(ROOT, TEMPORARY_ROOT);
  assert.ok(TEMPORARY_ROOT.startsWith(os.tmpdir()));
});

test("a conflict is resolved by a counted Reviewer integration session", async () => {
  const { ctx, ops, sessions, saves } = fakeContext({
    ops: { "sync-base": [CONFLICT] },
    sessions: [RESOLVED],
  });
  const end = await sync(ctx);
  assert.equal(sessions.length, 1);
  const task = sessions[0]?.task ?? "";
  assert.match(task, RESOLUTION_TASK);
  assert.match(task, CODE_SIDE);
  assert.match(task, CONFLICTED_FILE);
  assert.match(task, FIRST_ATTEMPT);
  assert.equal(sessions[0]?.agent, "issue-pipeline-reviewer");
  assert.equal(sessions[0]?.model, ctx.cfg.models.reviewer);
  assert.equal(sessions[0]?.commits, true);
  assert.equal(sessions[0]?.phase, "integration");
  assert.deepEqual(payloadsOf(ops, "finish-sync"), [
    { number: ISSUE, baseSha: BASE },
  ]);
  assert.deepEqual(
    saves.map((state) => state.counts.conflictFixes),
    [1],
  );
  assert.ok(end.ok);
  assert.equal(end.value.counts.conflictFixes, 1);
});

test("rejected resolutions rebase afresh, up to exactly maxConflictFixes attempts", async () => {
  const { ctx, ops, sessions, saves } = fakeContext({
    ops: { "sync-base": [CONFLICT], "finish-sync": [REJECTED] },
    sessions: [RESOLVED],
  });
  const end = await sync(ctx);
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
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "conflict");
  assert.match(end.end.reason, OUT_OF_ATTEMPTS);
  assert.equal(end.end.state.counts.conflictFixes, 2);
});

test("an issue out of conflict attempts stops before another resolver session", async () => {
  const { ctx, ops, sessions } = fakeContext({
    state: { counts: { conflictFixes: 2, syncs: 0 } },
    ops: { "sync-base": [CONFLICT] },
  });
  const end = await sync(ctx);
  assert.equal(sessions.length, 0);
  assert.equal(firstFinish(ops, "finish-sync").abort, true);
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "conflict");
});

test("a transient resolver aborts the rebase and defers, counting nothing", async () => {
  const { ctx, ops, saves } = fakeContext({
    ops: { "sync-base": [CONFLICT] },
    sessions: [{ ok: false, transient: true, error: "ECONNRESET" }],
  });
  const end = await sync(ctx);
  assert.deepEqual(end, {
    ok: false,
    end: { kind: "deferred", error: "ECONNRESET" },
  });
  assert.equal(saves.length, 0);
  assert.equal(firstFinish(ops, "finish-sync").abort, true);
  assert.ok(!opNames(ops).includes("verify"));
});

test("cannot-fix is counted and goes through code finish classification; rejected work retries within the bound", async () => {
  const { ctx, ops, sessions } = fakeContext({
    ops: {
      "sync-base": [CONFLICT, CONFLICT, CLEAN],
      "finish-sync": [REJECTED, { resolved: true }],
    },
    sessions: [
      { ok: true, reply: { outcome: "cannot-fix", summary: "too tangled" } },
      RESOLVED,
    ],
  });
  const end = await sync(ctx);
  assert.equal(sessions.length, CANNOT_FIX_RUN_SESSIONS);
  const finishes = payloadsOf(ops, "finish-sync");
  const first = firstFinish(ops, "finish-sync");
  assert.equal(first.abort, undefined);
  const { cannotFix, baseSha } = finishes[0] ?? {};
  assert.equal(cannotFix, true);
  assert.equal(baseSha, BASE);
  assert.match(String(first.reason), CANNOT_FIX_REASON);
  assert.deepEqual(finishes[1], { number: ISSUE, baseSha: BASE });
  assert.ok(end.ok);
  assert.equal(end.value.counts.conflictFixes, 2);
});

test("a conflict reported with no stopped rebase stops with error", async () => {
  const { ctx, sessions } = fakeContext({
    ops: { "sync-base": [{ ...CONFLICT, inRebase: false }] },
  });
  const end = await sync(ctx);
  assert.equal(sessions.length, 0);
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "error");
});

test("a wiki conflict is resolved in docs/ through the wiki's own sync ops", async () => {
  const { ctx, ops, sessions } = fakeContext({
    ops: {
      "wiki-sync": [{ ...CONFLICT, conflicts: ["Chats.md"], branch: "master" }],
    },
    sessions: [RESOLVED],
  });
  const end = await sync(ctx, "wiki");
  const task = sessions[0]?.task ?? "";
  assert.match(task, WIKI_SIDE);
  assert.match(task, CONFLICTED_PAGE);
  assert.deepEqual(payloadsOf(ops, "finish-wiki-sync"), [{ number: ISSUE }]);
  assert.equal(payloadsOf(ops, "finish-sync").length, 0);
  assert.ok(end.ok);
});

test("a rebase the merge's own checks already started goes on from its conflict, with no new wiki-sync", async () => {
  const { ctx, ops, sessions } = fakeContext({
    ops: { "wiki-sync": [] },
    sessions: [RESOLVED],
  });
  /** @type {import("../src/roles/op-replies.ts").Conflict} */
  const first = { ...CONFLICT, conflict: true, conflicts: ["Chats.md"] };
  const end = await syncSide(ctx, ctx.state, {
    side: "wiki",
    maxConflictFixes: 2,
    first,
  });
  assert.ok(end.ok);
  assert.equal(sessions.length, 1);
  assert.equal(payloadsOf(ops, "wiki-sync").length, 0);
});

test("a failed resolver session aborts the rebase and stops with error, counting nothing", async () => {
  const { ctx, ops, saves } = fakeContext({
    ops: { "sync-base": [CONFLICT] },
    sessions: [{ ok: false, transient: false, error: "no reply" }],
  });
  const end = await sync(ctx);
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "error");
  assert.match(end.end.reason, FAILED_RESOLVER);
  assert.equal(saves.length, 0);
  assert.equal(end.end.state.counts.conflictFixes, 0);
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
  await assert.rejects(sync(ctx), failure);
});

test("a stopped wiki rebase past maxConflictFixes aborts through finish-wiki-sync", async () => {
  const { ctx, ops, sessions } = fakeContext({
    ops: { "wiki-sync": [{ ...CONFLICT, conflicts: ["Chats.md"] }] },
  });
  const end = await sync(ctx, "wiki", 0);
  assert.equal(sessions.length, 0);
  const aborts = payloadsOf(ops, "finish-wiki-sync");
  assert.equal(aborts.length, 1);
  assert.equal(firstFinish(ops, "finish-wiki-sync").abort, true);
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "conflict");
  assert.match(end.end.reason, WIKI_OUT_OF_ATTEMPTS);
});
