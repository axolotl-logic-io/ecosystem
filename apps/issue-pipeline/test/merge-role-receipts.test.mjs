// @ts-check
// Own-result checks save M without replacing H or granting a postmerge writer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MERGED_REVISION, merging } from "./merge-role-test-kit.mjs";
import {
  firstPayload,
  opNames,
  savesOf,
  sessionsOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  COMMENT_ID,
  HEAD,
  MERGE_COMMIT,
  mergeRole,
  PR,
  REVISION,
} from "./reviewer-and-merge-role-kit.mjs";

test("own merge saves the original receipt, exact-M verification, security and completion separately", async () => {
  const { ctx, calls } = merging();
  await mergeRole(ctx);
  const saves = savesOf(calls);
  assert.equal(saves[0]?.stage, "merge");
  assert.deepEqual(saves[0]?.merged, MERGED_REVISION);
  assert.equal(saves[0]?.security, null);
  assert.equal(saves[1]?.verifiedSha, MERGE_COMMIT);
  assert.deepEqual(saves[1]?.hardened, REVISION);
  assert.deepEqual(saves[2]?.security, {
    revision: MERGED_REVISION,
    commentId: COMMENT_ID,
    finding: null,
  });
  assert.equal(saves[3]?.stage, "done");
  assert.deepEqual(saves[3]?.security, saves[2]?.security);
  const { state: finished } = firstPayload(calls, "finish-wiki");
  assert.deepEqual(finished, saves[3]);
  assert.deepEqual(firstPayload(calls, "verify"), {
    number: ctx.issue,
    codeMerged: { pr: PR, sha: MERGE_COMMIT },
  });
});

for (const checks of [
  [],
  [{ id: "test", pass: false, detail: "failed on combined M" }],
]) {
  test(`an own-result verify failure with ${checks.length} failed rows stops without a writer or completion`, async () => {
    const { ctx, calls } = merging({
      ops: { verify: [{ pass: false, headSha: MERGE_COMMIT, checks }] },
    });
    const end = await mergeRole(ctx);
    assert.ok(end.kind === "stop");
    assert.equal(end.code, "error");
    assert.deepEqual(end.state.merged, MERGED_REVISION);
    assert.deepEqual(end.state.hardened, REVISION);
    assert.equal(end.state.verifiedSha, HEAD);
    assert.equal(end.state.security, null);
    assert.equal(sessionsOf(calls).length, 0);
    for (const name of ["push", "sync-base", "prepare-review", "finish-wiki"]) {
      assert.ok(!opNames(calls).includes(name), name);
    }
    assert.deepEqual(
      savesOf(calls).map((saved) => saved.merged),
      [MERGED_REVISION],
    );
  });
}
