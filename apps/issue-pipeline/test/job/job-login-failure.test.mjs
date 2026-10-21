// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "../isolated-root-test-kit.mjs";

const { newIssueState } = await import("../../src/state.ts");
const { thrownEnd } = await import("../../src/job/role-end.ts");
const { OpsFailure, OPS_FAILED } = await import(
  "../../src/job/role-context.ts"
);
const ISSUE_NUMBER = 7;
const PREFIX =
  "credential login verification failed for merge; expected @merge-bot; ";

for (const classification of [
  "wrong account: observed @other",
  "authentication rejected (HTTP 401)",
]) {
  test(`identity rejection still stops despite transient stderr: ${classification}`, () => {
    const message = `${PREFIX}${classification}; gh exit status 1; stderr: HTTP 503 connection reset`;
    const state = newIssueState(ISSUE_NUMBER);
    const end = thrownEnd(
      new OpsFailure("push", OPS_FAILED, message, message),
      state,
    );
    assert.equal(end.kind, "stop");
    assert.ok(end.kind === "stop");
    assert.equal(end.code, "error");
    assert.equal(end.state, state);
    assert.ok(end.reason.includes(message));
  });
}

test("exhausted transient verification retains the ordinary bounded caller deferral policy", () => {
  const message = `${PREFIX}unverifiable after 4 attempts; gh exit status 1; stderr: HTTP 503`;
  const end = thrownEnd(
    new OpsFailure("push", OPS_FAILED, message, message),
    newIssueState(ISSUE_NUMBER),
  );
  assert.equal(end.kind, "deferred");
});
