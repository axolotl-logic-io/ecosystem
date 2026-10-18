// @ts-check
// The stop op through the ops CLI on version 2 states: a stop at an active
// stage resumes there, and a stopped completion (done) resumes at merge,
// whose job reconciles the completion again, never at the author.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { kit, v2State } from "./ops-v2-test-kit.mjs";

const { askOps, reply } = kit;
const REVIEWING = 61;
const COMPLETED = 62;
const PR = 7;
const SHA_LENGTH = 40;
const MERGED = { code: "a".repeat(SHA_LENGTH), wiki: null, inputs: "inputs-1" };
const STOP_REPLY = z.looseObject({
  ok: z.literal(true),
  state: z.record(z.string(), z.unknown()),
});

/** @param {Record<string, unknown>} state @returns {Record<string, unknown>} */
function stoppedOf(state) {
  reply([]);
  const { number } = state;
  const out = askOps({
    op: "stop",
    number,
    code: "error",
    reason: "GitHub doesn't confirm the merge",
    state,
  });
  return STOP_REPLY.parse(out).state;
}

test("a stop at an active stage resumes at that stage", () => {
  const { stage, stoppedStage, stopCode } = stoppedOf(
    v2State(REVIEWING, { stage: "review" }),
  );
  assert.equal(stage, "stopped");
  assert.equal(stoppedStage, "review");
  assert.equal(stopCode, "error");
});

test("a stopped completion resumes at merge with its merged revision kept", () => {
  const { stage, stoppedStage, merged } = stoppedOf(
    v2State(COMPLETED, { stage: "done", pr: PR, merged: MERGED }),
  );
  assert.equal(stage, "stopped");
  assert.equal(stoppedStage, "merge");
  assert.deepEqual(merged, MERGED);
});
