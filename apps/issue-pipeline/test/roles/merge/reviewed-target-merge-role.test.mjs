// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { world } from "../../explicit-target-world-test-kit.mjs";
import { context, current, names } from "./explicit-target-role-test-kit.mjs";

const { mergeRole } = await import("../../../src/roles/merge/merge.ts");

for (const timing of ["entry", "after CI", "before transport"]) {
  test(`target movement ${timing} returns to fresh review without an integration writer or mutation retry`, async () => {
    const w = world({ fastForward: true });
    const moved = { ...current(w), baseSha: w.head };
    let revisions = [moved];
    if (timing === "after CI") {
      revisions = [current(w), moved];
    }
    /** @type {string[]} */
    let expectedTargets = [];
    if (timing === "before transport") {
      revisions = [current(w), current(w)];
      expectedTargets = [w.base];
    }
    const run = context(w, {
      ops: {
        "current-revision": revisions,
        "ci-status": [{ status: "pass" }],
        merge: [{ merged: false, reason: "target-changed" }],
      },
    });
    const end = await mergeRole(run.ctx);
    assert.ok(end.kind === "next");
    assert.equal(end.state.stage, "review");
    assert.equal(names(run.calls).includes("session"), false);
    assert.equal(names(run.calls).includes("sync-base"), false);
    assert.equal(names(run.calls).includes("push"), false);
    const targets = run.calls.flatMap((call) => {
      if (call.kind === "op" && call.name === "merge") {
        if ("expectedBase" in call.payload) {
          return [call.payload.expectedBase];
        }
        return [undefined];
      }
      return [];
    });
    assert.deepEqual(targets, expectedTargets);
  });
}

test("a missing historical target is readable but cannot authorize a new merge or writer", async () => {
  const w = world({ fastForward: true });
  const run = context(w, {
    state: { hardenedTarget: null },
    ops: { "current-revision": [current(w)] },
  });
  const end = await mergeRole(run.ctx);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.deepEqual(names(run.calls), ["current-revision"]);
});
