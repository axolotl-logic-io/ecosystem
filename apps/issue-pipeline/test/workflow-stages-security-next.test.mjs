// @ts-check
// The security review's step machine (src/workflow/stages/security.ts),
// driven directly with recorded results and a fixed clock. The trace tests
// run it through the sweep; these pin the prompt, the findings' rounds, the
// save and each stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SECURITY_RULES } from "../src/workflow/lenses.ts";
import { SECURITY_SCHEMA } from "../src/workflow/review-schemas.ts";
import { next } from "../src/workflow/stages/security.ts";
import {
  deferral,
  deferredFrom,
  NETWORK_FAILURE,
} from "./deferral-test-kit.mjs";
import {
  CTX,
  contextWith,
  DIFF,
  decided,
  MODELS,
  prepared,
  ROLES,
  replied,
  SHORT_SHA,
  SIGNATURE,
  STAMP,
  sessionEnded,
  stateWith,
  taskOf,
  VERIFIED,
} from "./workflow-finish-test-kit.mjs";

/** @import { Launch, Step } from "../src/workflow/stages/types.ts" */
/** @import { IssueState } from "../src/workflow/types.ts" */
/** @typedef {Parameters<typeof stateWith>[1]} Fields */

const BY = { ...SIGNATURE, role: "security reviewer" };
const LEAK = {
  file: "a.ts",
  line: 3,
  title: "Leaks the token",
  evidence: "It logs the token.",
  suggestion: "Drop the log line.",
  category: "user-harm",
};
// The rounds before the last one maxFixRounds allows, and after it.
const LAST_ROUND = 1;
const PAST_ROUNDS = 2;
const SMALL_BUDGET = 40_000;

/** @returns {string} */
function securityTask() {
  return taskOf("security reviewer", ROLES.reviewer, [
    "You are the last review before this PR merges. Review the full diff against integration at /d.diff (12 lines), reading surrounding code where needed, for harm to the app's users and the operator.",
    ...SECURITY_RULES,
    "Cite file, line and concrete evidence for each finding. Return an empty list if you find nothing. Do not edit files.",
  ]);
}

/** @param {IssueState} st @returns {Launch} */
function saveLaunch(st) {
  return {
    kind: "op",
    name: "save",
    op: "save-state",
    payload: { number: 7, state: st },
  };
}

/** @param {Step} step @returns {readonly [Launch, ...Launch[]]} */
function launchesOf(step) {
  if (step.done) {
    throw new Error("the step ended instead of launching");
  }
  return step.launches;
}

/** @param {Fields} fields @returns {unknown} */
function prepTag(fields) {
  const [launch] = launchesOf(next(stateWith("security", fields), CTX, []));
  if (launch.kind !== "op") {
    throw new Error(`${launch.name} is not an ops request`);
  }
  const { tag } = launch.payload;
  return tag;
}

/** @param {unknown[]} findings @param {Fields} [fields] @returns {Step} */
function reviewed(findings, fields = {}) {
  return decided(next, stateWith("security", fields), { findings });
}

test("the security review tags its diff by round before charging the reviewer", () => {
  const given = stateWith("security");
  const step = next(given, CTX, []);
  assert.deepEqual(launchesOf(step), [
    {
      kind: "op",
      name: "prep",
      op: "prepare-review",
      payload: { number: 7, tag: "security-1" },
    },
  ]);
  assert.equal(step.state.st.allocated, 0);
  assert.equal(prepTag({ securityRounds: 2 }), "security-3");
  assert.deepEqual(given, stateWith("security"));
});

test("the reviewer is charged, then reads the full diff with the security rules", () => {
  const step = prepared(next, stateWith("security"));
  assert.equal(step.state.st.allocated, ROLES.reviewer);
  assert.deepEqual(step.state.st.sessions, ["reviewer"]);
  assert.deepEqual(launchesOf(step), [
    {
      kind: "child",
      name: "security",
      label: "Security review of issue 7",
      agent: "issue-pipeline-reader",
      model: MODELS.security,
      schema: SECURITY_SCHEMA,
      minutes: 25,
      task: securityTask(),
    },
  ]);
});

test("no findings moves the issue to merge, then saves it", () => {
  const step = reviewed([]);
  assert.equal(step.done, false);
  assert.equal(step.stop, null);
  assert.equal(step.state.st.stage, "merge");
  assert.deepEqual(step.state.st.log, [
    `${STAMP} charged reviewer 60000 to issueTokenBudget`,
    `${STAMP} security review: no findings`,
  ]);
  assert.deepEqual(step.comments, [
    {
      by: BY,
      body: `🛡️ Security review of ${SHORT_SHA}: no harm to users, their rights or money, and no new abuse risk.`,
      where: "pr",
    },
  ]);
  assert.deepEqual(launchesOf(step), [saveLaunch(step.state.st)]);
  const saved = replied(next, step, { ok: true });
  assert.deepEqual([saved.done, saved.comments, saved.stop], [true, [], null]);
  assert.equal(saved.state.st, step.state.st);
});

test("a finding within the rounds is stored and sent back to fix", () => {
  const given = stateWith("security");
  const step = decided(next, given, { findings: [LEAK] });
  const { st } = step.state;
  assert.deepEqual(st.findings, [
    {
      id: "f1",
      file: "a.ts",
      line: 3,
      title: "Leaks the token",
      evidence: "It logs the token.",
      suggestion: "Drop the log line.",
      lenses: ["security"],
      category: "user-harm",
      status: "open",
      disputed: false,
    },
  ]);
  assert.deepEqual(
    [st.securityRounds, st.reviewedSha, st.round, st.stage],
    [1, VERIFIED, 0, "fix"],
  );
  assert.equal(st.log?.at(-1), `${STAMP} security review 1: 1 finding(s)`);
  assert.deepEqual(step.comments, [
    {
      by: BY,
      body: `🛡️ Security review of ${SHORT_SHA} found 1 blocking finding(s). Later comments refer to these ids.\n\n- **f1** (user-harm) \`a.ts:3\` Leaks the token\n  It logs the token.`,
      where: "pr",
    },
  ]);
  assert.deepEqual(launchesOf(step), [saveLaunch(st)]);
  assert.deepEqual(given, stateWith("security"));
});

test("the last round's finding still goes back to fix", () => {
  const step = reviewed([LEAK], { securityRounds: LAST_ROUND });
  assert.equal(step.state.st.stage, "fix");
  assert.equal(step.stop, null);
});

test("a finding ends a re-check, since the fix is new code", () => {
  const step = reviewed([LEAK], { rechecking: true });
  assert.equal(step.state.st.stage, "fix");
  assert.equal(step.state.st.rechecking, false);
});

test("a re-check charges the reviewer to the rebase pool", () => {
  const given = stateWith("security", { rechecking: true, allocated: 0 });
  const begun = next(given, CTX, []);
  const step = next(begun.state, CTX, [{ kind: "op", reply: DIFF }]);
  assert.deepEqual(
    [step.state.st.allocated, step.state.st.rebaseAllocated],
    [0, ROLES.reviewer],
  );
});

test("a finding past the fix rounds stops with its harm as the code", () => {
  const step = reviewed([LEAK], { securityRounds: PAST_ROUNDS });
  assert.equal(step.done, true);
  assert.equal(Object.hasOwn(step, "launches"), false);
  assert.equal(step.state.st.securityRounds, PAST_ROUNDS + 1);
  assert.equal(step.comments.length, 1);
  assert.deepEqual(step.stop, {
    reason:
      "security review (user-harm): Leaks the token is still open after 2 fix rounds",
    detail:
      "- f1 (security: user-harm) [a.ts:3] Leaks the token\n  Evidence: It logs the token.\n  Suggestion: Drop the log line.",
    code: "user-harm",
  });
});

test("a failed or moved diff stops before the session", () => {
  const given = stateWith("security");
  const failed = prepared(next, given, { ok: false, error: "no diff" });
  assert.deepEqual(failed.stop, {
    reason: "could not prepare the security review diff",
    detail: "no diff",
    code: null,
  });
  const moved = prepared(next, given, { ...DIFF, headSha: "fedcba" });
  assert.deepEqual(moved.stop, {
    reason: "the branch changed after verification",
    detail: null,
    code: null,
  });
});

test("a diff that failed on the network defers to the next sweep", () => {
  const given = stateWith("security");
  const failed = prepared(next, given, { ok: false, error: NETWORK_FAILURE });
  assert.deepEqual(
    deferral(failed),
    deferredFrom(given, "prepare-review", STAMP),
  );
  assert.deepEqual(failed.comments, []);
});

test("a failed session or a malformed reply stops", () => {
  const step = prepared(next, stateWith("security"));
  const failed = sessionEnded(next, step, {
    ok: false,
    structuredOutput: null,
    error: "timed out",
  });
  assert.deepEqual(failed.stop, {
    reason: "the security reviewer failed",
    detail: "timed out",
    code: null,
  });
  const malformed = reviewed([{ file: "a.ts" }]);
  assert.deepEqual(malformed.stop, {
    reason: "the security reviewer failed",
    detail: null,
    code: null,
  });
});

test("a reviewer that doesn't fit the budget stops once the diff is ready", () => {
  const small = contextWith(SMALL_BUDGET);
  const begun = next(stateWith("security"), small, []);
  assert.equal(begun.stop, null);
  const step = next(begun.state, small, [{ kind: "op", reply: DIFF }]);
  assert.deepEqual(step.stop, {
    reason: "issue token budget exhausted",
    detail:
      "Allocated 0 of 40000 tokens (issueTokenBudget); the next step (reviewer) needs 60000.",
    code: null,
  });
});
