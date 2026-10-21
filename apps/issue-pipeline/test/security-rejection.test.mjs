// @ts-check
// Rejection binds harmful content, unlike policy/target-bound permission.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeContext } from "./roles/reviewer-and-merge-role-test-kit.mjs";

const { sameSecuritySubject } = await import("../src/security-clearance.ts");
const { rejectedAgain, securityReviewed } = await import(
  "../src/roles/merge/security.ts"
);
const { newIssueState } = await import("../src/state.ts");

const ISSUE = 7;
const REVISION = { code: "unsafe-code", inputs: "trusted-inputs" };
const REJECTED = {
  ...newIssueState(ISSUE),
  security: {
    revision: { ...REVISION, policy: "before" },
    commentId: 901,
    finding: { category: /** @type {const} */ ("rights"), reason: "unsafe" },
  },
};

for (const policy of ["after", undefined]) {
  test(`a policy change cannot reroll rejection of unchanged code and trusted inputs: ${policy}`, async () => {
    const revision = { ...REVISION, policy };
    assert.equal(
      sameSecuritySubject(REJECTED.security.revision, revision),
      true,
    );
    const stop = rejectedAgain(REJECTED, revision);
    assert.ok(stop?.kind === "stop");
    assert.equal(stop.code, "rights");
    const { ctx, calls } = fakeContext({ stage: "merge", state: REJECTED });
    const reviewed = await securityReviewed(ctx, REJECTED, {
      revision,
      codeMerged: null,
      still: () => true,
    });
    assert.equal(reviewed.ok, false);
    assert.deepEqual(calls, []);
  });
}

for (const revision of [
  { ...REVISION, code: "remediated-code" },
  { ...REVISION, inputs: "changed-consent" },
  { ...REVISION, wiki: "different-legacy-wiki" },
]) {
  test(`a different Security subject does not inherit rejection: ${JSON.stringify(revision)}`, () => {
    assert.equal(rejectedAgain(REJECTED, revision), null);
  });
}

test("absent and null legacy wiki retain the same Security rejection", () => {
  const stop = rejectedAgain(REJECTED, { ...REVISION, wiki: null });
  assert.ok(stop?.kind === "stop");
  assert.equal(stop.code, "rights");
});
