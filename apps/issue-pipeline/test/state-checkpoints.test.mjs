// @ts-check
// The installed version's state `checkpoints` (#301) and `plan` are gone from
// state version 2 (src/state.ts). What replaces their tests: a legacy state
// comment that carries them, well formed or malformed, still reads, migrated
// to the author with its PR and head kept and neither field (nor any other
// unknown one) carried over, so no role can resume from a stale checkpoint.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { parseStateBody } = await import("../src/saved-state.ts");

const ISSUE = 7;
const PR = 12;
const HEAD = "abc123";
const TRIES = 2;

/** @param {Record<string, unknown>} fields @returns {string} a legacy state comment's body */
function bodyOf(fields) {
  const state = {
    version: 1,
    number: ISSUE,
    stage: "implement",
    pr: PR,
    headSha: HEAD,
    ...fields,
  };
  return `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->\n<sub>x</sub>`;
}

test("a legacy state's checkpoints and plan are dropped by the migration", () => {
  const checkpoints = { tries: TRIES, plan: "a plan", sha: null };
  const state = parseStateBody(bodyOf({ checkpoints, plan: "kept" }), ISSUE);
  assert.ok(state !== null);
  assert.equal(state.version, 2);
  assert.equal(state.stage, "author");
  assert.equal(state.resumeStage, "implement");
  assert.equal(state.pr, PR);
  assert.equal(state.headSha, HEAD);
  assert.equal("checkpoints" in state, false);
  assert.equal("plan" in state, false);
});

test("malformed checkpoints never make a legacy state unreadable", () => {
  for (const checkpoints of [["tries"], { tries: { nested: 1 } }, "2"]) {
    const state = parseStateBody(bodyOf({ checkpoints }), ISSUE);
    assert.equal(state?.stage, "author");
    assert.equal(state?.pr, PR);
  }
});

test("a legacy state's unknown fields are not carried into version 2", () => {
  const state = parseStateBody(
    bodyOf({ checkpoints: { tries: 1 }, futureField: { a: 1 } }),
    ISSUE,
  );
  assert.ok(state !== null);
  assert.equal("futureField" in state, false);
});
