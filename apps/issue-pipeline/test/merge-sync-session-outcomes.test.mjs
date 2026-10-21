// @ts-check
// The model outcome cannot bypass deterministic finish classification.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, fakeContext } from "./implementor-test-kit.mjs";

const { syncCode } = await import("../src/roles/merge/sync.ts");

for (const outcome of /** @type {const} */ ([
  "conflict-resolved",
  "cannot-fix",
])) {
  test(`${outcome} before later picks that apply cleanly uses one session and one conflict attempt`, async () => {
    const { ctx, ops, sessions } = fakeContext({
      ops: {
        "sync-base": [
          {
            conflict: true,
            inRebase: true,
            conflicts: ["early-text"],
            baseSha: BASE,
          },
        ],
        "finish-sync": [{ resolved: true }],
      },
      sessions: [
        {
          ok: true,
          reply: { outcome, summary: "continued to a clean pick" },
        },
      ],
    });
    const end = await syncCode(ctx, ctx.state, 1);
    assert.equal(end.ok, true);
    assert.ok(end.ok && end.value.counts.conflictFixes === 1);
    assert.equal(sessions.length, 1);
    assert.equal(ops.filter((op) => op.name === "sync-base").length, 1);
    const finish = ops.find((op) => op.name === "finish-sync");
    const { abort, baseSha, cannotFix } = finish?.payload ?? {};
    assert.equal(abort, undefined);
    assert.equal(baseSha, BASE);
    assert.equal(cannotFix === true, outcome === "cannot-fix");
  });
}
