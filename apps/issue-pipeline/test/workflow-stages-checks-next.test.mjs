// @ts-check
// Checks' step machine (src/workflow/stages/checks.ts and its CI fix in
// ci-fix.ts), driven directly with recorded replies and a fixed clock. The
// trace tests run it through the sweep; these pin each outcome's step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { practicesNote } from "../src/workflow/prompts.ts";
import { REVIEW_SCHEMA } from "../src/workflow/review-schemas.ts";
import { CIFIX_SCHEMA } from "../src/workflow/schemas.ts";
import { next } from "../src/workflow/stages/checks.ts";
import {
  deferral,
  deferredFrom,
  NETWORK_FAILURE,
} from "./deferral-test-kit.mjs";
import { opsRequests, sessions } from "./stage-outcome-test-kit.mjs";
import {
  after,
  CTX,
  contextWith,
  MODELS,
  PATHS,
  replied,
  STAMP,
  sessionResult,
  stateAt,
  stepComment,
} from "./workflow-checks-test-kit.mjs";

/** @import { LaunchResult, StageContext, StageState, Step } from "../src/workflow/stages/types.ts" */
const HEAD = "cccccccccccccccc";
const FIXED_HEAD = "ffffffffffffffff";
const CI_FIXER_TOKENS = 100_000;
const REREVIEW_TOKENS = 80_000;
const FAILED = { id: "test", pass: false, detail: "1 failed", tail: "3 != 2" };
const PASSED = { id: "test", pass: true, detail: "passed" };
const FAILING = { ok: true, headSha: HEAD, pass: false, checks: [FAILED] };
const FIX = { status: "fixed", summary: "Fixed." };
const PREPARED = { ok: true, diffPath: "/w/d.diff" };
const PASSING = { ok: true, headSha: FIXED_HEAD, pass: true, checks: [PASSED] };
const CI_FAIL = {
  ok: true,
  status: "fail",
  failing: ["build"],
  logPath: "/w/ci.log",
};
const CI_PASS = { ok: true, status: "pass" };
const NO_FINDINGS = { findings: [] };
const BLOCKING = {
  severity: "blocking",
  file: "src/a.ts",
  line: 3,
  title: "Breaks b",
  evidence: "b() throws.",
  suggestion: "Guard it.",
};
const NO_BLOCKING =
  "Review of the check fix in ffffffffffff.\n\nNo blocking findings.";
const REBASED_NOTE = /acceptance and security passed before the rebase$/u;
const BLOCKING_HEADING = /\*\*Blocking\*\*/u;

// The CI status request for the PR's head `expectedSha`.
/** @param {string} expectedSha @returns {object} */
function ciRequest(expectedSha) {
  return { op: "ci-status", payload: { number: 7, pr: 42, expectedSha } };
}

const VERIFY_REQUEST = {
  op: "verify",
  payload: { number: 7, testsOnly: false },
};

/** @param {unknown} correctness @param {unknown} scope @returns {LaunchResult[]} */
function lensResults(correctness, scope) {
  return [
    sessionResult("cifix-review-correctness-1", correctness),
    sessionResult("cifix-review-scope-1", scope),
  ];
}

/**
 * Every step of a CI fix, from a failing verify up to the save's reply, with
 * the lenses replying `lenses` and the save's reply read under `ctx`
 * (`resumed` is `saving` when the stage ends before the save).
 * @param {StageContext} [ctx] @param {LaunchResult[]} [lenses] @returns {Readonly<Record<"begun" | "fixing" | "pushing" | "preparing" | "reviewing" | "saving" | "resumed", Step>>}
 */
function ciFixRun(ctx = CTX, lenses = lensResults(NO_FINDINGS, NO_FINDINGS)) {
  const begun = next(stateAt("checks"), CTX, []);
  const fixing = replied(next, begun, FAILING);
  const pushing = after(next, fixing, CTX, sessionResult("cifix-1", FIX));
  const preparing = replied(next, pushing, { ok: true, headSha: FIXED_HEAD });
  const reviewing = replied(next, preparing, PREPARED);
  const saving = after(next, reviewing, CTX, ...lenses);
  let resumed = saving;
  if (!saving.done) {
    resumed = replied(next, saving, { ok: true }, ctx);
  }
  return { begun, fixing, pushing, preparing, reviewing, saving, resumed };
}

test("failing verification launches a charged CI fixer after the checks' table", () => {
  const { begun, fixing } = ciFixRun();
  assert.deepEqual(opsRequests(begun), [VERIFY_REQUEST]);
  const [launch] = sessions(fixing);
  assert.ok(launch);
  assert.deepEqual(
    { ...launch, task: "" },
    {
      agent: "issue-pipeline-writer",
      model: MODELS.fixer,
      schema: CIFIX_SCHEMA,
      task: "",
    },
  );
  const note = practicesNote(CTX.cfg, { n: 7, paths: PATHS }, "writer");
  const failure = "- test: 1 failed\n3 != 2";
  assert.ok(
    launch.task.includes(`${note}\nThese checks failed:\n${failure}\n`),
  );
  assert.equal(fixing.state.st.ciFixes, 1);
  assert.equal(fixing.state.st.allocated, CI_FIXER_TOKENS);
  assert.deepEqual(fixing.comments, [
    stepComment(
      "local checks",
      "Ran the repo's commands on cccccccccccc.\n\n- ❌ test: 1 failed",
    ),
  ]);
});

test("a CI fix is pushed, its diff prepared, and reviewed by two lenses", () => {
  const { pushing, preparing, reviewing } = ciFixRun();
  assert.deepEqual(opsRequests(pushing), [
    { op: "push", payload: { number: 7 } },
  ]);
  assert.equal(pushing.comments[0]?.by.role, "check fixer (attempt 1)");
  assert.equal(preparing.state.st.headSha, FIXED_HEAD);
  assert.deepEqual(opsRequests(preparing), [
    {
      op: "prepare-review",
      payload: { number: 7, sinceSha: HEAD, tag: "cifix1" },
    },
  ]);
  const launched = sessions(reviewing).map(({ agent, model, schema }) => [
    agent,
    model,
    schema,
  ]);
  const reader = "issue-pipeline-reader";
  assert.deepEqual(launched, [
    [reader, MODELS.correctness, REVIEW_SCHEMA],
    [reader, MODELS.scope, REVIEW_SCHEMA],
  ]);
  assert.equal(reviewing.state.st.allocated, CI_FIXER_TOKENS + REREVIEW_TOKENS);
});

test("a reviewed CI fix is saved, then verified and passed to accept", () => {
  const { saving, resumed } = ciFixRun();
  assert.equal(saving.state.st.reviewedSha, FIXED_HEAD);
  assert.deepEqual(opsRequests(saving), [
    { op: "save-state", payload: { number: 7, state: saving.state.st } },
  ]);
  assert.deepEqual(
    saving.comments.map(({ by, body }) => [by.role, body]),
    [
      ["check-fix reviewer (correctness)", NO_BLOCKING],
      ["check-fix reviewer (scope)", NO_BLOCKING],
    ],
  );
  assert.deepEqual(opsRequests(resumed), [VERIFY_REQUEST]);
  const toCi = replied(next, resumed, PASSING);
  assert.deepEqual(opsRequests(toCi), [ciRequest(FIXED_HEAD)]);
  assert.equal(toCi.state.st.verifiedSha, FIXED_HEAD);
  assert.equal(toCi.state.st.verifySummary, "test: passed");
  const step = replied(next, toCi, { ok: true, status: "pass" });
  assert.deepEqual([step.done, step.stop], [true, null]);
  assert.equal(step.state.st.stage, "accept");
  assert.equal(step.state.rebasedOnly, false);
  assert.equal(step.state.st.log?.at(-1), `${STAMP} checks passed at ffffffff`);
});

test("a head that already passed verification goes straight to CI", () => {
  const step = next(stateAt("checks", { verifiedSha: HEAD }), CTX, []);
  assert.deepEqual(opsRequests(step), [ciRequest(HEAD)]);
});

test("passing CI after a clean rebase that only re-ran the tests goes to merge", () => {
  const given = stateAt("checks", { verifiedSha: HEAD, testsOnly: true });
  const step = replied(next, next(given, CTX, []), CI_PASS);
  assert.equal(step.state.st.stage, "merge");
  assert.equal(step.state.rebasedOnly, true);
  assert.equal(step.state.st.testsOnly, false);
  assert.match(step.state.st.log?.at(-1) ?? "", REBASED_NOTE);
});

test("pending CI ends the stage until next sweep without a stop", () => {
  const given = stateAt("checks", { verifiedSha: HEAD });
  const step = replied(next, next(given, CTX, []), {
    ok: true,
    status: "pending",
  });
  assert.deepEqual([step.done, step.stop], [true, null]);
  assert.equal(step.state.st.stage, "checks");
  assert.deepEqual(step.state.st.log, [
    `${STAMP} CI still running; will check next sweep`,
  ]);
});

// Checks' step after its first ops request, from `state`, fails with `error`.
/** @param {StageState} state @param {string} error @returns {Step} */
function failing(state, error) {
  return replied(next, next(state, CTX, []), { ok: false, error });
}

test("verify or CI that failed on the network defers; another failure stops", () => {
  const given = stateAt("checks");
  const atCi = stateAt("checks", { verifiedSha: HEAD });
  const verify = failing(given, NETWORK_FAILURE);
  assert.deepEqual(deferral(verify), deferredFrom(given, "verify", STAMP));
  const ci = failing(atCi, "gh exited 1: error connecting to api.github.com");
  assert.deepEqual(deferral(ci), deferredFrom(atCi, "ci-status", STAMP));
  const stops = [failing(given, "no such command"), failing(atCi, "HTTP 500")];
  assert.deepEqual(
    stops.map((step) => step.stop),
    [
      {
        reason: "local verification could not run",
        detail: "no such command",
        code: null,
      },
      { reason: "could not read CI status", detail: "HTTP 500", code: null },
    ],
  );
});

test("failing CI with its CI fixes used up stops with the failure", () => {
  const given = stateAt("checks", { verifiedSha: HEAD, ciFixes: 1 });
  const step = replied(next, next(given, CTX, []), CI_FAIL);
  assert.deepEqual(step.stop, {
    reason: "checks still fail after 1 CI-fix attempts",
    detail: "CI checks failed: build\nFailed-job logs: /w/ci.log",
    code: null,
  });
  assert.deepEqual(step.comments, [
    stepComment("CI", "Required checks failed on cccccccccccc: build."),
  ]);
});

test("no room under the spawn cap after a CI fix holds the issue at checks", () => {
  const { resumed } = ciFixRun(contextWith({ hasRoom: () => false }));
  assert.deepEqual([resumed.done, resumed.stop], [true, null]);
  assert.equal(resumed.state.held, true);
  assert.equal(
    resumed.state.st.log?.at(-1),
    `${STAMP} held at checks by the per-run spawn cap; continues next sweep`,
  );
});

test("a blocking finding in the CI fix stops before the save", () => {
  const blocked = lensResults({ findings: [BLOCKING] }, NO_FINDINGS);
  const { saving } = ciFixRun(CTX, blocked);
  assert.deepEqual(saving.stop, {
    reason: "the check fix introduced a blocking problem",
    detail: "src/a.ts:3 Breaks b - b() throws.",
    code: null,
  });
  assert.equal(saving.done, true);
  assert.equal(saving.comments.length, 2);
  assert.match(saving.comments[0]?.body ?? "", BLOCKING_HEADING);
});
