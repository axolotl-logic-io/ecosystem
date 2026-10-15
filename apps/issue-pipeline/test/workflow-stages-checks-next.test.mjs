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

const HEAD = "cccccccccccccccc";
const FIXED_HEAD = "ffffffffffffffff";
const CI_FIXER_TOKENS = 100_000;
const REREVIEW_TOKENS = 80_000;
// The configured CI wait, 30 minutes, and its margin of 10.
const CI_MINUTES = 40;
const VERIFY_MINUTES = 120;
const REVIEW_MINUTES = 20;
const FAILED = { id: "test", pass: false, detail: "1 failed", tail: "3 != 2" };
const PASSED = { id: "test", pass: true, detail: "passed" };
const CI_FAIL = {
  ok: true,
  status: "fail",
  failing: ["build"],
  logPath: "/w/ci.log",
};
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

function ciLaunch(expectedSha) {
  const payload = { number: 7, pr: 42, expectedSha };
  return {
    kind: "op",
    name: "ci",
    op: "ci-status",
    payload,
    minutes: CI_MINUTES,
  };
}

const VERIFY_LAUNCH = {
  kind: "op",
  name: "verify",
  op: "verify",
  payload: { number: 7, testsOnly: false },
  minutes: VERIFY_MINUTES,
};

function lensResults(correctness, scope) {
  return [
    sessionResult("cifix-review-correctness-1", correctness),
    sessionResult("cifix-review-scope-1", scope),
  ];
}

// Every step of a CI fix, from a failing verify up to the save's reply, with
// the lenses replying `lenses` and the save's reply read under `ctx`.
function ciFixRun(ctx = CTX, lenses = lensResults(NO_FINDINGS, NO_FINDINGS)) {
  const begun = next(stateAt("checks"), CTX, []);
  const fixing = replied(next, begun, {
    ok: true,
    headSha: HEAD,
    pass: false,
    checks: [FAILED],
  });
  const fixed = sessionResult("cifix-1", {
    status: "fixed",
    summary: "Fixed.",
  });
  const pushing = after(next, fixing, CTX, fixed);
  const preparing = replied(next, pushing, { ok: true, headSha: FIXED_HEAD });
  const reviewing = replied(next, preparing, {
    ok: true,
    diffPath: "/w/d.diff",
  });
  const saving = after(next, reviewing, CTX, ...lenses);
  let resumed = null;
  if (!saving.done) {
    resumed = replied(next, saving, { ok: true }, ctx);
  }
  return { begun, fixing, pushing, preparing, reviewing, saving, resumed };
}

test("failing verification launches a charged CI fixer after the checks' table", () => {
  const { begun, fixing } = ciFixRun();
  assert.deepEqual(begun.launches, [VERIFY_LAUNCH]);
  const [launch] = fixing.launches;
  assert.deepEqual(
    { ...launch, task: "" },
    {
      kind: "child",
      name: "cifix-1",
      label: "Fix failing checks for issue 7",
      agent: "issue-pipeline-writer",
      model: MODELS.fixer,
      schema: CIFIX_SCHEMA,
      writer: true,
      minutes: 60,
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
  assert.deepEqual(pushing.launches, [
    { kind: "op", name: "push", op: "push", payload: { number: 7 } },
  ]);
  assert.equal(pushing.comments[0].by.role, "check fixer (attempt 1)");
  assert.equal(preparing.state.st.headSha, FIXED_HEAD);
  assert.deepEqual(preparing.launches[0].payload, {
    number: 7,
    sinceSha: HEAD,
    tag: "cifix1",
  });
  const launched = reviewing.launches.map(
    ({ name, model, schema, minutes }) => [name, model, schema, minutes],
  );
  assert.deepEqual(launched, [
    [
      "cifix-review-correctness-1",
      MODELS.correctness,
      REVIEW_SCHEMA,
      REVIEW_MINUTES,
    ],
    ["cifix-review-scope-1", MODELS.scope, REVIEW_SCHEMA, REVIEW_MINUTES],
  ]);
  assert.equal(reviewing.state.st.allocated, CI_FIXER_TOKENS + REREVIEW_TOKENS);
});

test("a reviewed CI fix is saved, then verified and passed to accept", () => {
  const { saving, resumed } = ciFixRun();
  assert.equal(saving.state.st.reviewedSha, FIXED_HEAD);
  assert.deepEqual(saving.launches, [
    {
      kind: "op",
      name: "save",
      op: "save-state",
      payload: { number: 7, state: saving.state.st },
    },
  ]);
  assert.deepEqual(
    saving.comments.map(({ by, body }) => [by.role, body]),
    [
      ["check-fix reviewer (correctness)", NO_BLOCKING],
      ["check-fix reviewer (scope)", NO_BLOCKING],
    ],
  );
  assert.deepEqual(resumed.launches, [VERIFY_LAUNCH]);
  const toCi = replied(next, resumed, {
    ok: true,
    headSha: FIXED_HEAD,
    pass: true,
    checks: [PASSED],
  });
  assert.deepEqual(toCi.launches, [ciLaunch(FIXED_HEAD)]);
  assert.equal(toCi.state.st.verifiedSha, FIXED_HEAD);
  assert.equal(toCi.state.st.verifySummary, "test: passed");
  const step = replied(next, toCi, { ok: true, status: "pass" });
  assert.deepEqual([step.done, step.stop], [true, null]);
  assert.equal(step.state.st.stage, "accept");
  assert.equal(step.state.rebasedOnly, false);
  assert.equal(step.state.st.log.at(-1), `${STAMP} checks passed at ffffffff`);
});

test("a head that already passed verification goes straight to CI", () => {
  const step = next(stateAt("checks", { verifiedSha: HEAD }), CTX, []);
  assert.deepEqual(step.launches, [ciLaunch(HEAD)]);
});

test("passing CI after a clean rebase that only re-ran the tests goes to merge", () => {
  const given = stateAt("checks", { verifiedSha: HEAD, testsOnly: true });
  const step = replied(next, next(given, CTX, []), {
    ok: true,
    status: "pass",
  });
  assert.equal(step.state.st.stage, "merge");
  assert.equal(step.state.rebasedOnly, true);
  assert.equal(step.state.st.testsOnly, false);
  assert.match(step.state.st.log.at(-1), REBASED_NOTE);
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
    resumed.state.st.log.at(-1),
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
  assert.match(saving.comments[0].body, BLOCKING_HEADING);
});
