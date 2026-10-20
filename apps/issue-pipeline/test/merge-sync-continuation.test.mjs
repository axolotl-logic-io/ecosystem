// @ts-check
// Deterministic continuation returns only the next text stop to the role.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, fakeContext } from "./implementor-test-kit.mjs";

const { syncSide } = await import("../src/roles/merge/sync.ts");
const CONFLICT = {
  conflict: true,
  inRebase: true,
  conflicts: ["text"],
  baseSha: BASE,
};
/** @type {import("../src/job/role-context.ts").SessionResult} */
const RESOLVED = {
  ok: true,
  reply: { outcome: "conflict-resolved", summary: "Staged text only" },
};

test("subsequent text stops get bounded sessions without restarting the code rebase", async () => {
  const { ctx, ops, sessions } = fakeContext({
    ops: {
      "sync-base": [CONFLICT],
      "finish-sync": [
        { ...CONFLICT, conflicts: ["next-text"] },
        { resolved: true },
      ],
    },
    sessions: [RESOLVED],
  });
  const end = await syncSide(ctx, ctx.state, {
    side: "code",
    maxConflictFixes: 2,
  });
  assert.equal(sessions.length, 2);
  assert.ok(sessions[1]?.task.includes("next-text"));
  assert.ok(sessions[0]?.task.includes("Do not continue the code rebase"));
  assert.equal(ops.filter((op) => op.name === "sync-base").length, 1);
  assert.equal(end.ok, true);
  assert.ok(end.ok && end.value.counts.conflictFixes === 2);
});

test("a later text stop cannot exceed the existing conflict-fix limit", async () => {
  const { ctx, ops, sessions } = fakeContext({
    ops: {
      "sync-base": [CONFLICT],
      "finish-sync": [CONFLICT, { resolved: false, reason: "aborted" }],
    },
    sessions: [RESOLVED],
  });
  const end = await syncSide(ctx, ctx.state, {
    side: "code",
    maxConflictFixes: 1,
  });
  assert.equal(sessions.length, 1);
  assert.ok(!end.ok && end.end.kind === "stop" && end.end.code === "conflict");
  assert.ok(
    ops.some((op) => {
      const { abort } = op.payload;
      return op.name === "finish-sync" && abort === true;
    }),
  );
});
