// @ts-check
// The implementor's verification loop: verify and wiki-check after the work,
// exactly `maxCiFixes` fix sessions for failing checks and then the
// check-fixes stop, `cannot` as checks-unrelated, and a transient fix
// session deferring with nothing pushed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertTemporaryRoot,
  DONE,
  fakeContext,
  HEAD,
  opNames,
} from "./implementor-test-kit.mjs";

const { implementorRole } = await import(
  "../src/roles/implementor/implementor.ts"
);

const FIXED = "9".repeat(40);
const FAILING = {
  pass: false,
  headSha: HEAD,
  checks: [
    { id: "test", pass: false, detail: "exit 1", log: "/l/t.log", tail: "AssertionError: 2 !== 3" },
    { id: "lint", pass: true, detail: "exit 0" },
  ],
};
const PASSING = { pass: true, headSha: FIXED, checks: [] };

/** @param {string[]} names */
function count(names, name = "verify") {
  return names.filter((each) => each === name).length;
}

test("the tests run under a temporary pipeline root", () => {
  assertTemporaryRoot();
});

test("a failing check gets a fix session, and the fixed head is the one pushed", async () => {
  const { ctx, ops, sessions } = fakeContext({
    ops: {
      verify: [FAILING, PASSING],
      "open-pr": [{ pr: 12, headSha: FIXED, codeChanged: true, wikiAhead: 0 }],
    },
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 2);
  const fix = sessions[1]?.task ?? "";
  assert.match(fix, /fix attempt 1 of 2/u);
  assert.match(fix, /### test: exit 1/u);
  assert.match(fix, /AssertionError: 2 !== 3/u);
  assert.doesNotMatch(fix, /### lint/u);
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
  assert.match(sessions[1]?.task ?? "", /wiki-orphan:New/u);
  assert.equal(end.kind, "next");
});

test("checks that keep failing get exactly maxCiFixes fix sessions, then stop", async () => {
  for (const maxCiFixes of [0, 1, 3]) {
    const { ctx, ops, sessions } = fakeContext({
      config: { maxCiFixes },
      ops: { verify: [FAILING] },
      sessions: [DONE],
    });
    const end = await implementorRole(ctx);
    assert.equal(sessions.length, 1 + maxCiFixes, `maxCiFixes ${maxCiFixes}`);
    assert.equal(count(opNames(ops)), 1 + maxCiFixes);
    assert.ok(!opNames(ops).includes("open-pr"));
    assert.ok(end.kind === "stop");
    assert.equal(end.code, "check-fixes");
    assert.match(end.reason, new RegExp(`after ${maxCiFixes} check-fix attempts.*test`, "u"));
  }
});

test("a fixer that can't fix the checks stops checks-unrelated", async () => {
  const { ctx } = fakeContext({
    ops: { verify: [FAILING] },
    sessions: [DONE, { ok: true, reply: { outcome: "cannot", reason: "the DB is down" } }],
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "checks-unrelated");
  assert.match(end.reason, /the DB is down/u);
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
