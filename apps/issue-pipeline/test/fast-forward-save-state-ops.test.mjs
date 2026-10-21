// @ts-check
// Real framed ops child boundary. Requires the parent's heavy reservation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { posts } from "./explicit-target-recovery-test-kit.mjs";
import { calls, consumed } from "./explicit-target-test-kit.mjs";
import { BASE, BRANCH, git, ISSUE } from "./explicit-target-world-test-kit.mjs";
import { confirmedLostResponse } from "./fast-forward-save-state-test-kit.mjs";
import { OPS } from "./ops-run-test-kit.mjs";

const { readWriteState } = await import("../src/saved-state.ts");

for (const finding of [
  null,
  { category: /** @type {const} */ ("rights"), reason: "unsafe result" },
]) {
  for (const op of ["save-state", "release"]) {
    test(`framed ${op} child preserves lost-response FF evidence and decision: ${JSON.stringify(finding)}`, () => {
      const { w, confirmed, security } = confirmedLostResponse(finding);
      const request = {
        op,
        config: path.join(w.place, "config.json"),
        checkout: { issue: ISSUE, dir: w.wt, branch: BRANCH },
        number: ISSUE,
        state: w.state,
        lane: "lost-response",
        sweepId: "stale-job",
      };
      const child = spawnSync(process.execPath, [OPS], {
        input: `BEGIN_OPS_REQUEST\n${JSON.stringify(request)}\nEND_OPS_REQUEST`,
        cwd: w.wt,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(child.status, 0, `${child.stderr} ${child.error}`);
      assert.deepEqual(JSON.parse(child.stdout), {
        ok: true,
        op,
        posted: 0,
        commentIds: [],
      });
      const retained = readWriteState(w.cfg, ISSUE);
      assert.deepEqual(retained.merged, confirmed.merged);
      assert.deepEqual(retained.security, security);
      assert.deepEqual(retained.codeMerged, confirmed.codeMerged);
      assert.deepEqual(retained.mergeAttempt, confirmed.mergeAttempt);
      assert.equal(retained.mergeAttempt?.result, null);
      assert.deepEqual(retained.hardened, confirmed.hardened);
      assert.deepEqual(retained.hardenedTarget, confirmed.hardenedTarget);
      assert.deepEqual(retained.integration, confirmed.integration);
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
