// @ts-check
// Acceptance's step machine (src/workflow/stages/accept.ts) and the parents'
// close requests (stages/parents.ts), driven directly with recorded results
// and a fixed clock. The trace tests run them through the sweep; these pin
// the prompt, each verdict's step and each stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCEPT_SCHEMA } from "../src/workflow/schemas.ts";
import { next } from "../src/workflow/stages/accept.ts";
import {
  closeParentLaunches,
  parentsClosed,
} from "../src/workflow/stages/parents.ts";
import {
  deferral,
  deferredFrom,
  NETWORK_FAILURE,
} from "./deferral-test-kit.mjs";
import {
  asRequests,
  opsRequests,
  sessions,
} from "./stage-outcome-test-kit.mjs";
import {
  CTX,
  DIFF,
  decided,
  MODELS,
  prepared,
  replied,
  SIGNATURE,
  STAMP,
  sessionEnded,
  stateWith,
  taskOf,
  VERIFIED,
} from "./workflow-finish-test-kit.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */
/** @import { Session } from "./stage-outcome-test-kit.mjs" */

const SPEC = "## Behaviour\n\n- It works.";
// A spec clipped in the saved state, and where its full text is (#280).
const CLIPPED = "## Behaviour\n\n1. The clipped copy…";
const SPEC_FILE = "/w/runs/o__r/issue-7/spec.md";
const READ_WHOLE = /Read the whole spec there/u;
// An issue budget smaller than one verifier session.
const BY = { ...SIGNATURE, role: "acceptance verifier" };
const FIRST_PARENT = 5;
const SECOND_PARENT = 9;
const PARENTS = [FIRST_PARENT, SECOND_PARENT];
const EXPECTED_REPLY = /expected the reply to one ops request/u;

// The verifier's whole task, with or without a spec.
/** @param {string} spec @returns {string} */
function acceptTask(spec) {
  let specLine = "";
  let specNote = "";
  if (spec !== "") {
    specLine = `The spec it was built to (also on the issue):\n${spec}\n`;
    specNote = " and every Behaviour and Wiki update in the spec";
  }
  return taskOf("acceptance verifier", [
    "Decide whether the change, as a whole, does what the issue asks. Tests, lint, and CI already pass (test: ok); do not re-run them.",
    specLine,
    "Full diff against integration: /d.diff.",
    `Return \`pass\` only if every requirement in the issue${specNote} is met and nothing in the diff works against the issue. Otherwise \`fail\` with the unmet requirement. Do not edit files.`,
  ]);
}

/** @param {string} task @returns {Session} */
function verifierSession(task) {
  return {
    agent: "issue-pipeline-reader",
    model: MODELS.verifier,
    schema: ACCEPT_SCHEMA,
    task,
  };
}

/** @param {unknown} output @returns {Step} */
function accepted(output) {
  return decided(next, stateWith("accept"), output);
}

test("acceptance prepares the final diff before launching the verifier", () => {
  const given = stateWith("accept");
  const step = next(given, CTX, []);
  assert.equal(step.done, false);
  assert.deepEqual(opsRequests(step), [
    { op: "prepare-review", payload: { number: 7, tag: "final" } },
  ]);
  assert.equal(step.state.phase, "review");
  assert.deepEqual([step.comments, step.stop], [[], null]);
  assert.deepEqual(given, stateWith("accept"));
});

test("the verifier reads the final diff and the checks' summary", () => {
  const step = prepared(next, stateWith("accept"));
  assert.equal(step.done, false);
  assert.equal(step.state.phase, "decide");
  assert.deepEqual(sessions(step), [verifierSession(acceptTask(""))]);
});

test("the verifier also judges the spec when the issue has one", () => {
  const step = prepared(next, stateWith("accept", { spec: SPEC }));
  assert.equal(step.done, false);
  assert.deepEqual(sessions(step), [verifierSession(acceptTask(SPEC))]);
});

test("a clipped spec reaches the verifier by its full text's path", () => {
  const given = stateWith("accept", { spec: CLIPPED, specFile: SPEC_FILE });
  const [session] = sessions(prepared(next, given));
  const task = session?.task ?? "";
  assert.ok(task.includes(SPEC_FILE));
  assert.match(task, READ_WHOLE);
  assert.ok(!task.includes(CLIPPED));
});

test("a pass keeps the reason and moves the issue to security", () => {
  const step = accepted({ verdict: "pass", reason: "Does it." });
  assert.equal(step.done, true);
  assert.equal(step.stop, null);
  assert.equal(step.state.st.stage, "security");
  assert.equal(step.state.st.acceptReason, "Does it.");
  assert.deepEqual(step.state.st.log, [`${STAMP} acceptance: pass - Does it.`]);
  assert.deepEqual(step.comments, [
    {
      by: BY,
      body: "✅ The change does what the issue asks. Does it.",
      where: "pr",
    },
  ]);
});

test("a fail stores an open acceptance finding and saves the issue at fix", () => {
  const given = stateWith("accept", { round: 1 });
  const step = decided(next, given, { verdict: "fail", reason: "Misses b." });
  assert.equal(step.done, false);
  assert.equal(step.stop, null);
  const { st } = step.state;
  assert.equal(st.stage, "fix");
  assert.deepEqual(
    st.findings.map(({ lenses, evidence, status }) => ({
      lenses,
      evidence,
      status,
    })),
    [{ lenses: ["acceptance"], evidence: "Misses b.", status: "open" }],
  );
  assert.equal(st.round, 1);
  assert.equal(st.reviewedSha, VERIFIED);
  assert.deepEqual(opsRequests(step), [
    { op: "save-state", payload: { number: 7, state: st } },
  ]);
  assert.deepEqual(step.comments, [
    {
      by: BY,
      body: "❌ The change doesn't fully resolve the issue. Misses b.",
      where: "pr",
    },
  ]);
  const done = replied(next, step, { ok: true });
  assert.deepEqual([done.done, done.stop], [true, null]);
  assert.equal(done.state.st.stage, "fix");
});

test("a failed or moved diff stops before the session", () => {
  const given = stateWith("accept");
  const failed = prepared(next, given, { ok: false, error: "no diff" });
  assert.deepEqual(failed.stop, {
    reason: "could not prepare the final diff",
    detail: "no diff",
    code: null,
  });
  const moved = prepared(next, given, { ...DIFF, headSha: "fedcba" });
  assert.deepEqual(moved.stop, {
    reason: "the branch changed after verification",
    detail: null,
    code: null,
  });
  assert.equal(Object.hasOwn(moved, "launches"), false);
});

test("a diff that failed on the network defers to the next sweep", () => {
  const given = stateWith("accept");
  const failed = prepared(next, given, { ok: false, error: NETWORK_FAILURE });
  assert.deepEqual(
    deferral(failed),
    deferredFrom(given, "prepare-review", STAMP),
  );
  assert.deepEqual(failed.comments, []);
});

test("a failed session or a malformed reply stops", () => {
  const step = prepared(next, stateWith("accept"));
  const failed = sessionEnded(next, step, {
    ok: false,
    structuredOutput: null,
    error: "timed out",
  });
  assert.deepEqual(failed.stop, {
    reason: "the acceptance verifier failed",
    detail: "timed out",
    code: null,
  });
  const malformed = accepted({ verdict: "maybe", reason: "?" });
  assert.deepEqual(malformed.stop, {
    reason: "the acceptance verifier failed",
    detail: null,
    code: null,
  });
  assert.deepEqual(malformed.comments, []);
});

// Issue #7 at accept with `fields`, its diff ready for the verifier.
/** @param {Parameters<typeof stateWith>[1]} fields @returns {Step} */
function diffReady(fields) {
  const begun = next(stateWith("accept", fields), CTX, []);
  return next(begun.state, CTX, [{ kind: "op", reply: DIFF }]);
}

test("a re-check far past the old issue budget and rebase allowance still gets its verifier", () => {
  // Spend fields a state saved before budgets-bound-context holds, past the
  // 2M issue budget and the 500k rebase allowance that once stopped it.
  const spent = /** @type {Parameters<typeof stateWith>[1]} */ (
    /** @type {unknown} */ ({
      allocated: 2_500_000,
      rebaseAllocated: 600_000,
      rechecking: true,
    })
  );
  const step = diffReady(spent);
  assert.equal(step.stop, null);
  assert.equal(step.state.phase, "decide");
  assert.deepEqual(sessions(step), [verifierSession(acceptTask(""))]);
});

test("each parent gets a close request for its number", () => {
  assert.deepEqual(asRequests(closeParentLaunches(PARENTS)), [
    { op: "close-parent", payload: { number: FIRST_PARENT } },
    { op: "close-parent", payload: { number: SECOND_PARENT } },
  ]);
  assert.deepEqual(closeParentLaunches([]), []);
});

test("only a reply that closed its parent counts", () => {
  const replies = [
    { ok: true, closed: true },
    { ok: true, closed: false },
    { ok: false, closed: true, error: "gh failed" },
    { ok: true, closed: true },
  ];
  assert.equal(parentsClosed(replies), 2);
  assert.equal(parentsClosed([]), 0);
});

// A step that replies to an unexpected launch is a bug in the sweep's loop.
test("acceptance rejects a session result where it expects a reply", () => {
  const begun = next(stateWith("accept"), CTX, []);
  assert.throws(
    () => sessionEnded(next, begun, { ok: true, structuredOutput: {} }),
    EXPECTED_REPLY,
  );
});
