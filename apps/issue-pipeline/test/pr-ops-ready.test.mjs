// @ts-check
// The deterministic readiness guard through the ops CLI, without hardening.
import assert from "node:assert/strict";
import { test } from "node:test";
import { opsFixture } from "./ops-fixture.mjs";

const fx = await opsFixture("pr-ops-ready");
const { newIssueState } = await import("../src/state.ts");
const { ghIsRead } = await import("../src/github.ts");
const NO_HARDENED_AUTHORIZATION = /no hardened authorization/u;
const REOPENED = { n: 11, pr: 61 };

// ready-pr's guards are in ready-pr-op.test.mjs; through the ops CLI it is a
// PR op that fails, writing nothing, without a hardened authorization.
test("ready-pr is an op, and refuses a state no hardening authorized, writing nothing", () => {
  const { n, pr } = REOPENED;
  fx.fakeGh.reply([]);
  const state = { ...newIssueState(n), pr };
  const out = JSON.parse(fx.ask({ op: "ready-pr", number: n, state }));
  assert.equal(out.ok, false);
  assert.match(out.error, NO_HARDENED_AUTHORIZATION);
  assert.deepEqual(fx.fakeGh.writes(ghIsRead), []);
});
