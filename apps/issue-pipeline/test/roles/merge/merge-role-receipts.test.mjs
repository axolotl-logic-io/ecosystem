// @ts-check
// Own-result confirmation saves M without replacing H, running a postmerge
// suite or granting a postmerge writer (#185).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firstPayload,
  opNames,
  savesOf,
  sessionsOf,
} from "../reviewer-and-merge-role-calls-test-kit.mjs";
import {
  COMMENT_ID,
  HEAD,
  MERGE_COMMIT,
  mergeRole,
  PR,
  REVISION,
  sha,
} from "../reviewer-and-merge-role-test-kit.mjs";
import { MERGED_REVISION, merging, UNPROVEN } from "./merge-role-test-kit.mjs";

test("own merge saves the original receipt, then completion with candidate security, after read-only confirmation and no postmerge suite", async () => {
  const { ctx, calls } = merging();
  await mergeRole(ctx);
  const saves = savesOf(calls);
  assert.equal(saves[0]?.stage, "merge");
  assert.equal(saves[0]?.merged, null);
  assert.deepEqual(saves[1]?.merged, MERGED_REVISION);
  assert.equal(saves[1]?.verifiedSha, HEAD);
  assert.deepEqual(saves[1]?.hardened, REVISION);
  assert.deepEqual(saves[0]?.security, {
    revision: REVISION,
    phase: "candidate",
    target: { repo: ctx.cfg.repo, branch: ctx.cfg.baseBranch, sha: sha("b") },
    commentId: COMMENT_ID,
    finding: null,
  });
  assert.equal(saves[2]?.stage, "done");
  assert.deepEqual(saves[2]?.security, saves[1]?.security);
  assert.equal(saves.at(-1), saves[2]);
  const { state: finished } = firstPayload(calls, "finish");
  assert.deepEqual(finished, saves[2]);
  assert.equal(opNames(calls).includes("verify"), false);
  assert.deepEqual(firstPayload(calls, "confirm-merged"), {
    number: ctx.issue,
    codeMerged: { pr: PR, sha: MERGE_COMMIT },
  });
});

for (const [why, confirmation] of Object.entries({
  "missing premerge proof": UNPROVEN,
  "another confirmed result": { confirmed: true, headSha: sha("d") },
})) {
  test(`an own-result confirmation of ${why} stops without a suite, writer or completion`, async () => {
    const { ctx, calls } = merging({
      ops: { "confirm-merged": [confirmation] },
    });
    const end = await mergeRole(ctx);
    assert.ok(end.kind === "stop");
    assert.equal(end.code, "error");
    assert.deepEqual(end.state.merged, MERGED_REVISION);
    assert.deepEqual(end.state.hardened, REVISION);
    assert.equal(end.state.verifiedSha, HEAD);
    assert.deepEqual(end.state.security?.revision, REVISION);
    assert.equal(sessionsOf(calls).length, 1);
    for (const name of ["verify", "push", "sync-base", "finish"]) {
      assert.ok(!opNames(calls).includes(name), name);
    }
    assert.deepEqual(
      savesOf(calls).map((saved) => saved.merged),
      [null, MERGED_REVISION],
    );
  });
}
