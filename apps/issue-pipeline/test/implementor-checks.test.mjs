// @ts-check
// The implementor's verification loop: verify and wiki-check after the work,
// exactly `maxCiFixes` fix sessions for failing checks and then the
// check-fixes stop, a fixer's `cannot` as the same check-fixes stop, and a
// transient fix session deferring with nothing pushed.
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import {
  DONE,
  fakeContext,
  HEAD,
  opNames,
  PR,
  ROOT,
  shaOf,
  TEMPORARY_ROOT,
} from "./implementor-test-kit.mjs";

const { implementorRole } = await import(
  "../src/roles/implementor/implementor.ts"
);

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

/** @param {string[]} names */
function count(names, name = "verify") {
  return names.filter((each) => each === name).length;
}

test("the tests run under a temporary pipeline root", () => {
  assert.equal(ROOT, TEMPORARY_ROOT);
  assert.ok(TEMPORARY_ROOT.startsWith(os.tmpdir()));
});

test("a failing check gets a fix session, and the fixed head is the one pushed", async () => {
  const { ctx, ops, sessions } = fakeContext({
    ops: {
      verify: [FAILING, PASSING],
      "open-pr": [{ pr: PR, headSha: FIXED, codeChanged: true, wikiAhead: 0 }],
    },
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 2);
  const fix = sessions[1]?.task ?? "";
  assert.match(fix, FIRST_OF_TWO);
  assert.match(fix, FAILED_TEST_HEADING);
  assert.match(fix, FAILED_TEST_TAIL);
  assert.doesNotMatch(fix, PASSED_LINT_HEADING);
  assert.equal(sessions[1]?.commits, true);
  assert.equal(count(opNames(ops)), 2);
  assert.ok(end.kind === "next");
  assert.equal(end.state.verifiedSha, FIXED);
});

test("a failing wiki check gets a fix session too", async () => {
  const { ctx, sessions } = fakeContext({
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
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 2);
  assert.match(sessions[1]?.task ?? "", WIKI_ORPHAN);
  assert.equal(end.kind, "next");
});

test("checks that keep failing get exactly maxCiFixes fix sessions, then stop", async () => {
  const runs = await Promise.all(
    MAX_CI_FIXES_CASES.map(async (maxCiFixes) => {
      const run = fakeContext({
        config: { maxCiFixes },
        ops: { verify: [FAILING] },
        sessions: [DONE],
      });
      return { maxCiFixes, run, end: await implementorRole(run.ctx) };
    }),
  );
  for (const { maxCiFixes, run, end } of runs) {
    const names = opNames(run.ops);
    assert.equal(run.sessions.length, 1 + maxCiFixes, `max ${maxCiFixes}`);
    assert.equal(count(names), 1 + maxCiFixes);
    assert.ok(!names.includes("open-pr"));
    assert.ok(end.kind === "stop");
    assert.equal(end.code, "check-fixes");
    assert.ok(
      end.reason.includes(`after ${maxCiFixes} check-fix attempts`),
      end.reason,
    );
  }
});

test("a fixer that can't fix the checks stops check-fixes at once, naming why", async () => {
  const { ctx, ops, sessions } = fakeContext({
    ops: { verify: [FAILING] },
    sessions: [
      DONE,
      { ok: true, reply: { outcome: "cannot", reason: "the DB is down" } },
    ],
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "check-fixes");
  assert.match(end.reason, CANNOT_REASON);
  assert.equal(sessions.length, 2);
  assert.equal(count(opNames(ops)), 1);
  assert.ok(!opNames(ops).includes("open-pr"));
});

test("a transient fix session defers with nothing pushed or counted", async () => {
  const { ctx, ops, saves } = fakeContext({
    ops: { verify: [FAILING] },
    sessions: [DONE, { ok: false, transient: true, error: "overloaded" }],
  });
  const end = await implementorRole(ctx);
  assert.deepEqual(end, { kind: "deferred", error: "overloaded" });
  assert.equal(count(opNames(ops)), 1);
  assert.ok(!opNames(ops).includes("open-pr"));
  assert.equal(saves.length, 0);
});

test("verify is the verdict, whatever the session says", async () => {
  const { ctx } = fakeContext({
    config: { maxCiFixes: 0 },
    ops: { verify: [{ ...FAILING, checks: [] }] },
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "check-fixes");
});
