// @ts-check
// security-skip-unchanged (#387): the security review records the tree it
// passed, and a later security stage at a head with that same tree passes
// without a session. Driven directly, as workflow-stages-security-next.test.mjs
// drives the rest of the stage, with prepare-review replies that carry the
// head's tree (headTree).
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/security.ts";
import { opsRequests, sessions } from "./stage-outcome-test-kit.mjs";
import {
  DIFF,
  prepared,
  replied,
  STAMP,
  sessionEnded,
  stateWith,
  VERIFIED,
} from "./workflow-finish-test-kit.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */
/** @import { IssueState } from "../src/workflow/types.ts" */
/** @import { OpsRequest } from "./stage-outcome-test-kit.mjs" */
// The saved fields a test starts from.
/** @typedef {Partial<IssueState>} Fields */

// The verified head's tree, as prepare-review replies it.
const TREE = "7eee7eee7eee7eee7eee7eee7eee7eee7eee7eee";
// Another tree: the code changed since the last pass.
const OTHER_TREE = "0dd0dd0dd0dd0dd0dd0dd0dd0dd0dd0dd0dd0dd0";
// The head the review last passed, and how the skip names it.
const PASSED = "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff";
const PASSED_SHORT = "c0ffeec0ffee";
const SKIP_TEXT = `security skipped: code unchanged since ${PASSED_SHORT}`;
const LEAK = {
  file: "a.ts",
  line: 3,
  title: "Leaks the token",
  evidence: "It logs the token.",
  suggestion: "Drop the log line.",
  category: "user-harm",
};

// The head and the tree the saved state records as last passed.
/** @param {IssueState} st @returns {[unknown, unknown]} */
function securityOf(st) {
  return [st.securitySha, st.securityTree];
}

// The request that saves `st`.
/** @param {IssueState} st @returns {OpsRequest} */
function saveRequest(st) {
  return { op: "save-state", payload: { number: 7, state: st } };
}

// The step after the diff was prepared with `diff` and the reviewer replied
// `findings`.
/** @param {Fields} fields @param {Readonly<Record<string, unknown>>} diff @param {unknown[]} findings @returns {Step} */
function reviewedWith(fields, diff, findings) {
  const step = prepared(next, stateWith("security", fields), diff);
  return sessionEnded(next, step, {
    ok: true,
    structuredOutput: { findings },
  });
}

test("a pass records the head and the tree it reviewed in the saved state, and a finding records neither", () => {
  const given = stateWith("security");
  const step = reviewedWith({}, { ...DIFF, headTree: TREE }, []);
  assert.deepEqual(step.state.st, {
    ...given.st,
    stage: "merge",
    log: [`${STAMP} security review: no findings`],
    securitySha: VERIFIED,
    securityTree: TREE,
  });
  assert.deepEqual(opsRequests(step), [saveRequest(step.state.st)]);
  /** @type {Fields} */
  const kept = { securitySha: PASSED, securityTree: OTHER_TREE };
  const found = reviewedWith(kept, { ...DIFF, headTree: TREE }, [LEAK]);
  assert.equal(found.state.st.stage, "fix");
  assert.deepEqual(securityOf(found.state.st), [PASSED, OTHER_TREE]);
});

test("a head whose tree equals the tree that last passed skips the review and moves to merge", () => {
  /** @type {Fields} */
  const fields = { securitySha: PASSED, securityTree: TREE };
  const given = stateWith("security", fields);
  const step = prepared(next, given, { ...DIFF, headTree: TREE });
  assert.equal(step.stop, null);
  assert.equal(step.done, false);
  const { st } = step.state;
  assert.equal(st.stage, "merge");
  assert.deepEqual(st.log, [`${STAMP} ${SKIP_TEXT}`]);
  assert.deepEqual(
    [...securityOf(st), st.securityRounds],
    [PASSED, TREE, undefined],
  );
  // The save is its only launch: opsRequests throws at a session.
  assert.deepEqual(opsRequests(step), [saveRequest(st)]);
  assert.equal(step.comments.length, 1);
  const [comment] = step.comments;
  assert.equal(comment?.where, "pr");
  assert.ok(comment?.body.includes(SKIP_TEXT), comment?.body);
  const saved = replied(next, step, { ok: true });
  assert.deepEqual([saved.done, saved.stop], [true, null]);
  // The diff's own checks still come first: a moved head stops.
  const moved = prepared(next, given, {
    ...DIFF,
    headSha: "fedcba",
    headTree: TREE,
  });
  assert.equal(moved.stop?.reason, "the branch changed after verification");
});

// Each case runs the reviewer, and its pass then records what it reviewed:
// the new tree, or none when the reply named no tree.
/** @type {{ name: string, fields: Fields, diff: Readonly<Record<string, unknown>>, recorded: string | null }[]} */
const RUNS = [
  {
    name: "a different tree",
    fields: { securitySha: PASSED, securityTree: OTHER_TREE },
    diff: { ...DIFF, headTree: TREE },
    recorded: TREE,
  },
  {
    name: "no saved tree",
    fields: {},
    diff: { ...DIFF, headTree: TREE },
    recorded: TREE,
  },
  {
    name: "a reply without a tree",
    fields: { securitySha: PASSED, securityTree: TREE },
    diff: DIFF,
    recorded: null,
  },
  {
    name: "an empty tree",
    fields: { securitySha: PASSED, securityTree: "" },
    diff: { ...DIFF, headTree: "" },
    recorded: null,
  },
];

for (const { name, fields, diff, recorded } of RUNS) {
  test(`with ${name} the review runs, and its pass records what it reviewed`, () => {
    const step = prepared(next, stateWith("security", fields), diff);
    assert.equal(sessions(step).length, 1);
    assert.equal(step.state.st.stage, "security");
    const passed = reviewedWith(fields, diff, []);
    const { st } = passed.state;
    assert.deepEqual(
      [st.stage, ...securityOf(st)],
      ["merge", VERIFIED, recorded],
    );
    assert.equal(st.log?.at(-1), `${STAMP} security review: no findings`);
  });
}
