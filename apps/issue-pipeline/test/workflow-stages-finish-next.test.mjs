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
  CTX,
  contextWith,
  DIFF,
  decided,
  MODELS,
  prepared,
  ROLES,
  SIGNATURE,
  STAMP,
  sessionEnded,
  stateWith,
  taskOf,
} from "./workflow-finish-test-kit.mjs";

/** @import { ChildLaunch, Step } from "../src/workflow/stages/types.ts" */

const SPEC = "## Behaviour\n\n- It works.";
// An issue budget smaller than one verifier session.
const SMALL_BUDGET = 40_000;
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
  return taskOf("acceptance verifier", ROLES.verifier, [
    "Decide whether the change, as a whole, does what the issue asks. Tests, lint, and CI already pass (test: ok); do not re-run them.",
    specLine,
    "Full diff against integration: /d.diff.",
    `Return \`pass\` only if every requirement in the issue${specNote} is met and nothing in the diff works against the issue. Otherwise \`fail\` with the unmet requirement. Do not edit files.`,
  ]);
}

/** @param {string} task @returns {ChildLaunch} */
function sessionLaunch(task) {
  return {
    kind: "child",
    name: "accept",
    label: "Check issue 7 is resolved",
    agent: "issue-pipeline-reader",
    model: MODELS.verifier,
    schema: ACCEPT_SCHEMA,
    minutes: 25,
    task,
  };
}

/** @param {unknown} output @returns {Step} */
function accepted(output) {
  return decided(next, stateWith("accept"), output);
}

test("acceptance prepares the final diff before charging the verifier", () => {
  const given = stateWith("accept");
  const step = next(given, CTX, []);
  assert.equal(step.done, false);
  assert.deepEqual(step.launches, [
    {
      kind: "op",
      name: "prep",
      op: "prepare-review",
      payload: { number: 7, tag: "final" },
    },
  ]);
  assert.equal(step.state.phase, "review");
  assert.equal(step.state.st.allocated, 0);
  assert.deepEqual([step.comments, step.stop], [[], null]);
  assert.deepEqual(given, stateWith("accept"));
});

test("the verifier is charged, then reads the final diff and the checks' summary", () => {
  const step = prepared(next, stateWith("accept"));
  assert.equal(step.done, false);
  assert.equal(step.state.phase, "decide");
  assert.equal(step.state.st.allocated, ROLES.verifier);
  assert.deepEqual(step.state.st.sessions, ["verifier"]);
  assert.deepEqual(step.launches, [sessionLaunch(acceptTask(""))]);
});

test("the verifier also judges the spec when the issue has one", () => {
  const step = prepared(next, stateWith("accept", { spec: SPEC }));
  assert.equal(step.done, false);
  assert.deepEqual(step.launches, [sessionLaunch(acceptTask(SPEC))]);
});

test("a pass keeps the reason and moves the issue to security", () => {
  const step = accepted({ verdict: "pass", reason: "Does it." });
  assert.equal(step.done, true);
  assert.equal(step.stop, null);
  assert.equal(step.state.st.stage, "security");
  assert.equal(step.state.st.acceptReason, "Does it.");
  assert.deepEqual(step.state.st.log, [
    `${STAMP} charged verifier 60000 to issueTokenBudget`,
    `${STAMP} acceptance: pass - Does it.`,
  ]);
  assert.deepEqual(step.comments, [
    {
      by: BY,
      body: "✅ The change does what the issue asks. Does it.",
      where: "pr",
    },
  ]);
});

test("a fail posts the verdict, then stops with the reason", () => {
  const step = accepted({ verdict: "fail", reason: "Misses b." });
  assert.equal(step.state.st.stage, "accept");
  assert.deepEqual(step.comments, [
    {
      by: BY,
      body: "❌ The change doesn't fully resolve the issue. Misses b.",
      where: "pr",
    },
  ]);
  assert.deepEqual(step.stop, {
    reason: "the acceptance verifier found the issue is not fully resolved",
    detail: "Misses b.",
    code: null,
  });
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

test("a verifier that doesn't fit the budget stops once the diff is ready", () => {
  const small = contextWith(SMALL_BUDGET);
  const begun = next(stateWith("accept"), small, []);
  assert.equal(begun.stop, null);
  const step = next(begun.state, small, [{ kind: "op", reply: DIFF }]);
  assert.equal(step.done, true);
  assert.deepEqual(step.stop, {
    reason: "issue token budget exhausted",
    detail:
      "Allocated 0 of 40000 tokens (issueTokenBudget); the next step (verifier) needs 60000.",
    code: null,
  });
  assert.equal(step.state.st.allocated, 0);
});

// Issue #7 at accept with `fields`, its diff ready for the verifier.
/** @param {Parameters<typeof stateWith>[1]} fields @returns {Step} */
function diffReady(fields) {
  const begun = next(stateWith("accept", fields), CTX, []);
  return next(begun.state, CTX, [{ kind: "op", reply: DIFF }]);
}

test("a re-check's verifier is charged to the rebase pool, and stops when it is spent", () => {
  const rechecking = { rechecking: true, allocated: 0, rebaseAllocated: 0 };
  const charged = diffReady(rechecking);
  assert.deepEqual(
    [charged.state.st.allocated, charged.state.st.rebaseAllocated],
    [0, ROLES.verifier],
  );
  const spent = { ...rechecking, rebaseAllocated: 460_000 };
  const step = diffReady(spent);
  assert.deepEqual(step.stop, {
    reason: "rebase token budget exhausted",
    detail:
      "Allocated 460000 of 500000 rebase tokens (rebaseTokenBudget); the next step (verifier) needs 60000.",
    code: null,
  });
});

test("each parent gets a close request keyed by its number", () => {
  assert.deepEqual(closeParentLaunches(PARENTS), [
    {
      kind: "op",
      name: "p5-close",
      op: "close-parent",
      payload: { number: 5 },
    },
    {
      kind: "op",
      name: "p9-close",
      op: "close-parent",
      payload: { number: 9 },
    },
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
