// @ts-check
// review-keeps-on-clean-rebase (#394): acceptance records the head and the
// patch id of the changes it passed, and a later acceptance at a head whose
// changes have that same patch id, after a clean rebase, keeps the verdict
// with no session. Security still runs on the rebased code. Driven directly,
// as workflow-stages-security-skip.test.mjs drives security's skip, with
// prepare-review replies that carry the changes' patch id (patchId).
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/accept.ts";
import { next as securityNext } from "../src/workflow/stages/security.ts";
import { sessions } from "./stage-outcome-test-kit.mjs";
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
// The saved fields a test starts from, with the ones #394 adds.
/** @typedef {Partial<IssueState> & { acceptedSha?: string | null, acceptedPatchId?: string | null }} Fields */

// The patch id of the verified head's changes, as prepare-review replies it.
const PATCH = "9a7c9a7c9a7c9a7c9a7c9a7c9a7c9a7c9a7c9a7c";
// Another patch id: the issue's changes are different since the last pass.
const OTHER_PATCH = "0dd0dd0dd0dd0dd0dd0dd0dd0dd0dd0dd0dd0dd0";
// The head acceptance last passed, and how the kept verdict names it.
const PASSED = "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff";
const KEPT_TEXT = "acceptance kept: changes unchanged since c0ffeec0ffee";
const TREE = "7eee7eee7eee7eee7eee7eee7eee7eee7eee7eee";
const OTHER_TREE = "1eaf1eaf1eaf1eaf1eaf1eaf1eaf1eaf1eaf1eaf";
const PASS = { verdict: "pass", reason: "Does what #7 asks." };
const FAIL = { verdict: "fail", reason: "The wiki misses the new stage." };

// What the saved state records as acceptance's last pass.
/** @param {Fields} st @returns {[unknown, unknown]} */
function acceptedOf(st) {
  return [st.acceptedSha, st.acceptedPatchId];
}

// The sessions `step` launches; none when it ended.
/** @param {Step} step @returns {number} */
function sessionCount(step) {
  if (step.done) {
    return 0;
  }
  return step.launches.filter((launch) => launch.kind === "child").length;
}

// The step after the stage ends: `step` itself, or the step after its save.
/** @param {Step} step @returns {Step} */
function ended(step) {
  if (step.done) {
    return step;
  }
  return replied(next, step, { ok: true });
}

// The step after the diff was prepared with `diff` and the verifier replied
// `verdict`.
/** @param {Fields} fields @param {Readonly<Record<string, unknown>>} diff @param {unknown} verdict @returns {Step} */
function judgedWith(fields, diff, verdict) {
  const step = prepared(next, stateWith("accept", fields), diff);
  return sessionEnded(next, step, { ok: true, structuredOutput: verdict });
}

/** @type {Fields} */
const KEPT = { acceptedSha: PASSED, acceptedPatchId: PATCH };

test("a head whose changes have the patch id acceptance passed keeps the verdict and moves to security", () => {
  const step = prepared(next, stateWith("accept", KEPT), {
    ...DIFF,
    patchId: PATCH,
  });
  assert.equal(step.stop, null);
  assert.equal(sessionCount(step), 0);
  const { st } = step.state;
  assert.equal(st.stage, "security");
  assert.deepEqual(st.log, [`${STAMP} ${KEPT_TEXT}`]);
  assert.deepEqual(acceptedOf(st), [PASSED, PATCH]);
  assert.equal(step.comments.length, 1);
  const [comment] = step.comments;
  assert.equal(comment?.where, "pr");
  assert.ok(comment?.body.includes(KEPT_TEXT), comment?.body);
  const end = ended(step);
  assert.deepEqual(
    [end.done, end.stop, end.state.st.stage],
    [true, null, "security"],
  );
});

test("a kept verdict still needs the verified head: a moved head stops", () => {
  const moved = prepared(next, stateWith("accept", KEPT), {
    ...DIFF,
    headSha: "fedcba",
    patchId: PATCH,
  });
  assert.equal(moved.stop?.reason, "the branch changed after verification");
});

// Each case runs the verifier, and its pass then records what it judged: the
// reply's patch id, or none when the reply named none.
/** @type {{ name: string, fields: Fields, diff: Readonly<Record<string, unknown>>, recorded: string | null }[]} */
const RUNS = [
  {
    name: "a different patch id",
    fields: { acceptedSha: PASSED, acceptedPatchId: OTHER_PATCH },
    diff: { ...DIFF, patchId: PATCH },
    recorded: PATCH,
  },
  {
    name: "no saved patch id",
    fields: {},
    diff: { ...DIFF, patchId: PATCH },
    recorded: PATCH,
  },
  {
    name: "a patch id that couldn't be computed",
    fields: KEPT,
    diff: { ...DIFF, patchId: null },
    recorded: null,
  },
  {
    name: "a reply without a patch id",
    fields: { acceptedSha: PASSED, acceptedPatchId: null },
    diff: DIFF,
    recorded: null,
  },
];

for (const { name, fields, diff, recorded } of RUNS) {
  test(`with ${name} the verifier runs, and its pass records what it judged`, () => {
    const step = prepared(next, stateWith("accept", fields), diff);
    assert.equal(sessions(step).length, 1);
    const passed = judgedWith(fields, diff, PASS);
    const { st } = passed.state;
    assert.deepEqual(
      [st.stage, ...acceptedOf(st)],
      ["security", VERIFIED, recorded],
    );
  });
}

test("a failed acceptance clears the verdict it kept", () => {
  const failed = judgedWith(KEPT, { ...DIFF, patchId: OTHER_PATCH }, FAIL);
  const { st } = failed.state;
  assert.deepEqual([st.stage, ...acceptedOf(st)], ["fix", null, null]);
});

test("after a kept acceptance the security review still runs on rebased code", () => {
  const kept = prepared(next, stateWith("accept", KEPT), {
    ...DIFF,
    patchId: PATCH,
  });
  const { st } = ended(kept).state;
  /** @type {Fields} */
  const security = { ...st, securitySha: PASSED, securityTree: OTHER_TREE };
  const step = prepared(securityNext, stateWith("security", security), {
    ...DIFF,
    headTree: TREE,
    patchId: PATCH,
  });
  assert.equal(sessions(step).length, 1);
  assert.equal(step.state.st.stage, "security");
});
