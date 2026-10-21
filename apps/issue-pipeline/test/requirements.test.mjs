// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { newIssueState } = await import("../src/state.ts");
const { readClaimState } = await import("../src/saved-state.ts");
const { requirementsHold, requirementsState } = await import(
  "../src/requirements.ts"
);
const { planOf } = await import("../src/orchestrator/issue-plan.ts");
const { COMMENT } = await import("../src/comments.ts");
const { githubComment } = await import("./fake-gh.mjs");
const { NOW, SETTINGS, snapshotOf } = await import(
  "./orchestrator-fixtures.mjs"
);

const ISSUE = 7;
const OLD = "inputs-0";
const CURRENT = "inputs-1";
const ACCOUNT = { mergeAccount: "merge", legacyAccount: undefined };
const INVALID = /saved write authority is invalid/u;

/** @param {object} state */
function savedComment(state) {
  return COMMENT.parse({
    ...githubComment({
      id: 1,
      login: "merge",
      body: "",
      created: NOW.toISOString(),
    }),
    body: `<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`,
  });
}

test("strict saved authority accepts old authored mode absence, but never malformed mode/input markers", () => {
  const {
    authorUsed: _mode,
    requirementsInputs: _inputs,
    ...old
  } = newIssueState(ISSUE, "author");
  const legacy = readClaimState(ACCOUNT, ISSUE, [savedComment(old)]);
  assert.equal(legacy?.authorUsed, true);
  assert.equal(legacy?.stage, "author");
  for (const invalid of [
    { authorUsed: null },
    { authorUsed: "false" },
    { requirementsInputs: 42 },
    { requirementsInputs: "" },
  ]) {
    assert.throws(
      () =>
        readClaimState(ACCOUNT, ISSUE, [savedComment({ ...old, ...invalid })]),
      INVALID,
    );
  }
});

for (const stage of /** @type {const} */ (["implement", "review", "merge"])) {
  test(`changed direct inputs at ${stage} route to Developer without Gherkin`, () => {
    const snapshot = snapshotOf([
      {
        number: ISSUE,
        stage: "implement",
        gherkin: null,
        state: { authorUsed: false, requirementsInputs: OLD },
      },
    ]);
    const [issue] = snapshot.issues;
    assert.ok(issue?.state);
    issue.state.stage = stage;
    const planned = planOf(issue, SETTINGS, NOW);
    assert.equal(planned.kind, "run");
    assert.ok(planned.kind === "run");
    assert.equal(planned.stage, "implement");
    assert.equal(planned.reason, "reauthor");
    const routed = requirementsState(issue.state, "review");
    assert.ok(routed);
    assert.equal(routed.stage, "implement");
    assert.equal(routed.resumeStage, null);
    assert.equal(requirementsHold(routed, null, CURRENT), false);
  });
}

test("an unchanged direct revision needs no Author and an unanswered requirement remains held", () => {
  const snapshot = snapshotOf([
    {
      number: ISSUE,
      stage: "review",
      gherkin: null,
      state: { authorUsed: false, requirementsInputs: CURRENT },
    },
  ]);
  const [issue] = snapshot.issues;
  assert.ok(issue?.state);
  assert.equal(requirementsHold(issue.state, null, CURRENT), true);
  const plan = planOf(issue, SETTINGS, NOW);
  assert.ok(plan.kind === "run");
  assert.equal(plan.stage, "review");
  const held = {
    ...issue,
    labels: ["agent:needs-info"],
    inputs: { current: CURRENT, gherkin: null, asked: CURRENT },
  };
  assert.deepEqual(planOf(held, SETTINGS, NOW), {
    kind: "held",
    stage: "review",
    reason: "needs-info",
  });
});
