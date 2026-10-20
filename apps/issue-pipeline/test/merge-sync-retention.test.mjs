// @ts-check
// A controlled conflict stop requires the operation's explicit recovery receipt.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, fakeContext } from "./implementor-test-kit.mjs";

const { syncSide } = await import("../src/roles/merge/sync.ts");
const { OpsFailure } = await import("../src/job/role-context.ts");
const CONFLICT = {
  conflict: true,
  inRebase: true,
  conflicts: ["later-text"],
  baseSha: BASE,
};
/** @type {import("../src/job/role-context.ts").SessionResult} */
const RESOLVED = {
  ok: true,
  reply: { outcome: "conflict-resolved", summary: "Staged text" },
};

test("evidence preparation failure does not claim a controlled retained conflict stop or erase a saved attempt", async () => {
  const failure = new OpsFailure(
    "finish-sync",
    1,
    "bundle verification failed",
  );
  const { ctx, sessions, saves, ops } = fakeContext({
    ops: { "sync-base": [CONFLICT], "finish-sync": [CONFLICT, failure] },
    sessions: [RESOLVED],
  });
  await assert.rejects(
    syncSide(ctx, ctx.state, { side: "code", maxConflictFixes: 1 }),
    failure,
  );
  assert.equal(sessions.length, 1);
  assert.deepEqual(
    saves.map((state) => state.counts.conflictFixes),
    [1],
  );
  const { retainConflict, abort, baseSha } = ops.at(-1)?.payload ?? {};
  assert.equal(retainConflict, true);
  assert.equal(abort, undefined);
  assert.equal(baseSha, BASE);
});

for (const reply of [
  { resolved: true },
  { resolved: false, reason: "no retention receipt" },
  CONFLICT,
]) {
  test(`a retention request rejects an incompatible receipt: ${JSON.stringify(reply)}`, async () => {
    const { ctx, sessions } = fakeContext({
      ops: { "sync-base": [CONFLICT], "finish-sync": [reply] },
    });
    await assert.rejects(
      syncSide(ctx, ctx.state, { side: "code", maxConflictFixes: 0 }),
      OpsFailure,
    );
    assert.equal(sessions.length, 0);
  });
}
