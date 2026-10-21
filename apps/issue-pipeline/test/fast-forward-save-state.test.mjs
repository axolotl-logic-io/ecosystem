// @ts-check
// Isolated source-module save/release tests. No ops CLI or job child.
import assert from "node:assert/strict";
import { test } from "node:test";
import { posts } from "./explicit-target-recovery-test-kit.mjs";
import { calls, consumed } from "./explicit-target-test-kit.mjs";
import { BASE, git, ISSUE, PR } from "./explicit-target-world-test-kit.mjs";
import { confirmedLostResponse } from "./fast-forward-save-state-test-kit.mjs";

const { readWriteState } = await import("../src/saved-state.ts");
const { release, saveState } = await import("../src/ops/save-state.ts");
const { readWriteAuthority } = await import("../src/write-authority.ts");

test("a real landed FF with lost acknowledgement saves only the exact intent receipt, not a response", () => {
  const { w, confirmed, reply } = confirmedLostResponse(null);
  assert.deepEqual(reply, {
    merged: true,
    mergeCommit: w.head,
    headSha: w.head,
  });
  assert.ok(confirmed.mergeAttempt !== null);
  assert.equal(confirmed.mergeAttempt.result, null);
  assert.deepEqual(confirmed.mergeAttempt.operation, {
    kind: "fast-forward",
    base: w.base,
  });
  assert.deepEqual(confirmed.merged, w.revision);
  assert.deepEqual(confirmed.codeMerged, { pr: PR, sha: w.head });
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.head);
  consumed();
});

for (const finding of [
  null,
  { category: /** @type {const} */ ("rights"), reason: "unsafe result" },
]) {
  for (const boundary of ["save-state", "release"]) {
    test(`${boundary} retains the lost-response FF receipt and exact decision: ${JSON.stringify(finding)}`, () => {
      const { w, confirmed, security } = confirmedLostResponse(finding);
      assert.equal(w.state.merged, null);
      assert.equal(w.state.security, null);
      const stale = {
        number: ISSUE,
        state: w.state,
        lane: "lost-response",
        sweepId: "stale-job",
      };
      if (boundary === "release") {
        release(w.cfg, stale);
      } else {
        saveState(w.cfg, stale);
      }
      const retained = readWriteState(w.cfg, ISSUE);
      assert.deepEqual(retained.merged, confirmed.merged);
      assert.deepEqual(retained.security, security);
      assert.deepEqual(retained.codeMerged, confirmed.codeMerged);
      assert.deepEqual(retained.mergeAttempt, confirmed.mergeAttempt);
      assert.deepEqual(retained.hardened, confirmed.hardened);
      assert.deepEqual(retained.hardenedTarget, confirmed.hardenedTarget);
      assert.deepEqual(retained.integration, confirmed.integration);
      assert.equal(retained.mergeAttempt?.result, null);
      assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
      assert.equal(git(w.origin, ["rev-parse", BASE]), w.head);
      assert.equal(posts().length, 1);
      assert.equal(
        calls().filter((args) => args.includes("event=APPROVE")).length,
        1,
      );
      consumed();
    });
  }
}
