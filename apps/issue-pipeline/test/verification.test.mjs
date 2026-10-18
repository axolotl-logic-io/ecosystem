// @ts-check
// The pipeline's verification (src/roles/verification.ts), which the
// Reviewer runs while it hardens and integrates a change: verify and
// wiki-check, exactly `maxCiFixes` fix sessions of the caller's phase for
// failing checks and then the check-fixes stop, a fixer's `cannot` as the
// same stop, a transient fix session deferring, and failing CI fixed first.
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import {
  DONE,
  fakeContext,
  HEAD,
  opNames,
  ROOT,
  shaOf,
  TEMPORARY_ROOT,
} from "./implementor-test-kit.mjs";

const { verifiedHead } = await import("../src/roles/verification.ts");

const FIXED = shaOf("9");
const FAILING = {
  pass: false,
  headSha: HEAD,
  checks: [
    {
      id: "test",
      pass: false,
      detail: "exit 1",
      log: "/l/t.log",
      tail: "AssertionError: 2 !== 3",
    },
    { id: "lint", pass: true, detail: "exit 0" },
  ],
};
const PASSING = { pass: true, headSha: FIXED, checks: [] };
const MANY_CI_FIXES = 3;
const MAX_CI_FIXES_CASES = [0, 1, MANY_CI_FIXES];

const FIRST_OF_TWO = /fix attempt 1 of 2/u;
const FAILED_TEST_HEADING = /### test: exit 1/u;
const FAILED_TEST_TAIL = /AssertionError: 2 !== 3/u;
const PASSED_LINT_HEADING = /### lint/u;
const WIKI_ORPHAN = /wiki-orphan:New/u;
const CANNOT_REASON = /fix attempt 1 of 2.*\(test\): the DB is down/u;

const FAILING_CI = [{ id: "ci/build", pass: false, detail: "failure" }];
const CI_CHECK_HEADING = /### ci\/build: failure/u;

/**
 * The verified head of the branch in `phase`, within the run's limit.
 * @param {ReturnType<typeof fakeContext>} run
 * @param {{ phase?: "hardening" | "integration", failing?: { id: string, pass: boolean, detail: string }[] }} [options]
 */
function verified(run, { phase = "hardening", failing = [] } = {}) {
  return verifiedHead(run.ctx, run.ctx.state, {
    mode: { kind: "branch" },
    phase,
    maxCiFixes: run.ctx.cfg.maxCiFixes,
    failing,
  });
}

/** @param {string[]} names */
function count(names, name = "verify") {
  return names.filter((each) => each === name).length;
}

test("the tests run under a temporary pipeline root", () => {
  assert.equal(ROOT, TEMPORARY_ROOT);
  assert.ok(TEMPORARY_ROOT.startsWith(os.tmpdir()));
});

test("a failing check gets a Reviewer fix session of the caller's phase, and the fixed head is the one verified", async () => {
  const run = fakeContext({ ops: { verify: [FAILING, PASSING] } });
  const end = await verified(run, { phase: "integration" });
  const { ops, sessions } = run;
  assert.equal(sessions.length, 1);
  const fix = sessions[0]?.task ?? "";
  assert.match(fix, FIRST_OF_TWO);
  assert.match(fix, FAILED_TEST_HEADING);
  assert.match(fix, FAILED_TEST_TAIL);
  assert.doesNotMatch(fix, PASSED_LINT_HEADING);
  assert.equal(sessions[0]?.agent, "issue-pipeline-reviewer");
  assert.equal(sessions[0]?.phase, "integration");
  assert.equal(sessions[0]?.commits, true);
  assert.equal(count(opNames(ops)), 2);
  assert.deepEqual(end, { ok: true, value: FIXED });
});

test("a failing wiki check gets a fix session too", async () => {
  const run = fakeContext({
    ops: {
      "wiki-check": [
        {
          pass: false,
          checks: [{ id: "wiki-orphan:New", pass: false, detail: "orphan" }],
        },
        { pass: true, checks: [] },
      ],
    },
  });
  const end = await verified(run);
  assert.equal(run.sessions.length, 1);
  assert.equal(run.sessions[0]?.phase, "hardening");
  assert.match(run.sessions[0]?.task ?? "", WIKI_ORPHAN);
  assert.equal(end.ok, true);
});

test("checks that keep failing get exactly maxCiFixes fix sessions, then stop", async () => {
  const runs = await Promise.all(
    MAX_CI_FIXES_CASES.map(async (maxCiFixes) => {
      const run = fakeContext({
        config: { maxCiFixes },
        ops: { verify: [FAILING] },
        sessions: [DONE],
      });
      return { maxCiFixes, run, end: await verified(run) };
    }),
  );
  for (const { maxCiFixes, run, end } of runs) {
    assert.equal(run.sessions.length, maxCiFixes, `max ${maxCiFixes}`);
    assert.equal(count(opNames(run.ops)), 1 + maxCiFixes);
    assert.ok(!end.ok && end.end.kind === "stop");
    assert.equal(end.end.code, "check-fixes");
    assert.ok(
      end.end.reason.includes(`after ${maxCiFixes} check-fix attempts`),
      end.end.reason,
    );
  }
});

test("a fixer that can't fix the checks stops check-fixes at once, naming why", async () => {
  const run = fakeContext({
    ops: { verify: [FAILING] },
    sessions: [
      { ok: true, reply: { outcome: "cannot", reason: "the DB is down" } },
    ],
  });
  const end = await verified(run);
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "check-fixes");
  assert.match(end.end.reason, CANNOT_REASON);
  assert.equal(run.sessions.length, 1);
  assert.equal(count(opNames(run.ops)), 1);
});

test("a transient fix session defers with nothing counted or saved", async () => {
  const run = fakeContext({
    ops: { verify: [FAILING] },
    sessions: [{ ok: false, transient: true, error: "overloaded" }],
  });
  const end = await verified(run);
  assert.deepEqual(end, {
    ok: false,
    end: { kind: "deferred", error: "overloaded" },
  });
  assert.equal(count(opNames(run.ops)), 1);
  assert.equal(run.saves.length, 0);
});

test("verify is the verdict, whatever the session says", async () => {
  const run = fakeContext({
    config: { maxCiFixes: 0 },
    ops: { verify: [{ ...FAILING, checks: [] }] },
  });
  const end = await verified(run);
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "check-fixes");
});

test("failing CI gets the first fix session before any verify, then verify decides", async () => {
  const run = fakeContext({ ops: { verify: [PASSING] } });
  const end = await verified(run, {
    phase: "integration",
    failing: FAILING_CI,
  });
  assert.equal(run.sessions.length, 1);
  assert.match(run.sessions[0]?.task ?? "", CI_CHECK_HEADING);
  assert.equal(opNames(run.ops).indexOf("verify"), 0);
  assert.deepEqual(end, { ok: true, value: FIXED });
});

test("failing CI with no check-fix attempt allowed stops at once, with no session", async () => {
  const run = fakeContext({ config: { maxCiFixes: 0 } });
  const end = await verified(run, { failing: FAILING_CI });
  assert.equal(run.sessions.length, 0);
  assert.equal(opNames(run.ops).length, 0);
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "check-fixes");
});
