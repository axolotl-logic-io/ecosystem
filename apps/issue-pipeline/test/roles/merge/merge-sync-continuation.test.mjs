// @ts-check
// Deterministic continuation returns only the next text stop to the role.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, fakeContext } from "../implementor-test-kit.mjs";

const { syncCode } = await import("../../../src/roles/merge/sync.ts");
const CONFLICT = {
  conflict: true,
  inRebase: true,
  conflicts: ["text"],
  baseSha: BASE,
};
/** @type {import("../../../src/job/role-context.ts").SessionResult} */
const RESOLVED = {
  ok: true,
  reply: { outcome: "conflict-resolved", summary: "Staged text only" },
};

test("subsequent text stops get bounded sessions without restarting the code rebase", async () => {
  const { ctx, ops, sessions, saves } = fakeContext({
    ops: {
      "sync-base": [CONFLICT],
      "finish-sync": [
        { ...CONFLICT, conflicts: ["next-text"] },
        { resolved: true },
      ],
    },
    sessions: [RESOLVED],
  });
  /** @type {number[]} */
  const checkpoints = [];
  const { op: perform } = ctx;
  ctx.op = async (name, payload) => {
    checkpoints.push(saves.at(-1)?.counts.conflictFixes ?? 0);
    return await perform(name, payload);
  };
  const end = await syncCode(ctx, ctx.state, 2);
  assert.equal(sessions.length, 2);
  assert.deepEqual(checkpoints, [0, 1, 2]);
  assert.ok(sessions[1]?.task.includes("next-text"));
  assert.ok(sessions[1]?.task.includes(`at \`${BASE}\``));
  assert.ok(sessions[1]?.task.includes("Attempt: 2 of 2"));
  assert.equal(
    sessions[1]?.task.includes("last resolution was rejected"),
    false,
  );
  assert.deepEqual(
    saves.map((state) => state.counts.conflictFixes),
    [1, 2],
  );
  assert.ok(sessions[0]?.task.includes("Do not continue the rebase"));
  assert.equal(ops.filter((op) => op.name === "sync-base").length, 1);
  assert.equal(end.ok, true);
  assert.ok(end.ok && end.value.counts.conflictFixes === 2);
});

test("a later text stop cannot exceed the existing conflict-fix limit", async () => {
  const { ctx, ops, sessions } = fakeContext({
    ops: {
      "sync-base": [CONFLICT],
      "finish-sync": [
        CONFLICT,
        {
          resolved: false,
          retained: true,
          reason:
            "maxConflictFixes reached; stopped pick and paths; retained evidence",
        },
      ],
    },
    sessions: [RESOLVED],
  });
  const end = await syncCode(ctx, ctx.state, 1);
  assert.equal(sessions.length, 1);
  assert.ok(!end.ok && end.end.kind === "stop" && end.end.code === "conflict");
  assert.ok(
    ops.some((op) => {
      const { retainConflict, abort } = op.payload;
      return (
        op.name === "finish-sync" &&
        retainConflict === true &&
        abort === undefined
      );
    }),
  );
});
