// @ts-check
// The issue state's `checkpoints` (#301): the values a role's run saved for a
// later start. A malformed record reads as missing, and the rest of the state
// stays readable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStateBody } from "../src/state.ts";

/** @param {Record<string, unknown>} fields @returns {string} a state comment's body */
function bodyOf(fields) {
  const state = { version: 1, number: 7, stage: "implement", ...fields };
  return `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->\n<sub>x</sub>`;
}

test("the state keeps its checkpoints", () => {
  const checkpoints = { tries: 2, plan: "a plan", sha: null };
  const state = parseStateBody(bodyOf({ checkpoints }));
  assert.deepEqual(state?.checkpoints, checkpoints);
});

test("malformed checkpoints read as missing, and the rest stays", () => {
  for (const checkpoints of [["tries"], { tries: { nested: 1 } }, "2"]) {
    const state = parseStateBody(bodyOf({ checkpoints, plan: "kept" }));
    const { checkpoints: read, stage, plan } = state ?? {};
    assert.equal(read, undefined);
    assert.equal(stage, "implement");
    assert.equal(plan, "kept");
  }
});

test("a state with checkpoints keeps its unknown fields", () => {
  const state = parseStateBody(
    bodyOf({ checkpoints: { tries: 1 }, futureField: { a: 1 } }),
  );
  const { futureField } = state ?? {};
  assert.deepEqual(futureField, { a: 1 });
});
