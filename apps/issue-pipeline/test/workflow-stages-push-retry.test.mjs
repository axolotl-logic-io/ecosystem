// @ts-check
// A fix round's push and a CI fix's push retry once when the push op fails
// before git pushes, such as when ops couldn't read its request (#263). A
// second such failure stops as a step failure; a git push rejection, on
// either push, stops as push-rejected.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stopFor } from "../src/stops.ts";
import { next as checksNext } from "../src/workflow/stages/checks.ts";
import { next as fixNext } from "../src/workflow/stages/fix.ts";
import {
  after,
  CTX as CHECKS_CTX,
  replied,
  sessionResult,
  stateAt,
} from "./workflow-checks-test-kit.mjs";
import { fixState, REJECTED_PUSH, round } from "./workflow-fix-test-kit.mjs";
import { CTX as REVIEW_CTX } from "./workflow-review-test-kit.mjs";

/** @import { StageContext, StageMachine, StageStop, Step } from "../src/workflow/stages/types.ts" */

const READ_FAILED = {
  ok: false,
  error: "EAGAIN: resource temporarily unavailable, read",
};
const REJECTED = REJECTED_PUSH.reply;
const PUSHED_HEAD = "ddddddddddddddd";
const PUSHED = { ok: true, headSha: PUSHED_HEAD };
const FAILING_CHECKS = {
  ok: true,
  headSha: "cccccccccccccccc",
  pass: false,
  checks: [{ id: "test", pass: false, detail: "1 failed", tail: "3 != 2" }],
};

/**
 * A stage whose push is about to reply: its `next`, context, the step that
 * launched the push, and what the push's success leads to.
 * @typedef {object} PushingStage
 * @property {string} name
 * @property {StageMachine["next"]} next
 * @property {StageContext} ctx
 * @property {Step} pushing
 * @property {Readonly<Record<string, unknown>>} prepPayload
 * @property {string} rejected the reason a rejected push stops with
 */

// The fix round's step that launched its push.
/** @returns {Step} */
function fixPushing() {
  return round(fixState()).fixed;
}

// The CI fix's step that launched its push, as in a failing verify's fix.
/** @returns {Step} */
function ciFixPushing() {
  const begun = checksNext(stateAt("checks"), CHECKS_CTX, []);
  const fixing = replied(checksNext, begun, FAILING_CHECKS);
  const fix = { status: "fixed", summary: "Fixed." };
  return after(checksNext, fixing, CHECKS_CTX, sessionResult("cifix-1", fix));
}

/** @type {PushingStage[]} */
const STAGES = [
  {
    name: "a fix round",
    next: fixNext,
    ctx: REVIEW_CTX,
    pushing: fixPushing(),
    prepPayload: { number: 7, sinceSha: "bbbbbbb", tag: "r1" },
    rejected: "could not push the fix",
  },
  {
    name: "a CI fix",
    next: checksNext,
    ctx: CHECKS_CTX,
    pushing: ciFixPushing(),
    prepPayload: { number: 7, sinceSha: "cccccccccccccccc", tag: "cifix1" },
    rejected: "could not push the check fix",
  },
];

const PUSH = { op: "push", payload: { number: 7 } };

// The stop `step` makes and the ops it launches, with their payloads.
/** @param {Step} step @returns {{ stop: StageStop | null, ops: { op: string | null, payload: unknown }[] }} */
function launched(step) {
  if (step.done) {
    return { stop: step.stop, ops: [] };
  }
  const ops = step.launches.map((launch) => {
    if (launch.kind !== "op") {
      return { op: null, payload: null };
    }
    return { op: launch.op, payload: launch.payload };
  });
  return { stop: step.stop, ops };
}

// The stop code `step` stops with, as its label names it.
/** @param {Step} step @returns {string | undefined} */
function stopCodeOf(step) {
  if (step.stop === null) {
    return;
  }
  return step.stop.code ?? stopFor(step.stop.reason)?.code;
}

// The step after `stage`'s `step` gets the ops reply `answer`.
/**
 * @param {PushingStage} stage @param {Step} step
 * @param {Readonly<Record<string, unknown>>} answer @returns {Step}
 */
function reply(stage, step, answer) {
  return stage.next(step.state, stage.ctx, [{ kind: "op", reply: answer }]);
}

// The step after `stage`'s first push fails before git pushes: the retry.
/** @param {PushingStage} stage @returns {Step} */
function retrying(stage) {
  const step = reply(stage, stage.pushing, READ_FAILED);
  if (step.done) {
    throw new Error("the failed push stopped instead of retrying");
  }
  return step;
}

for (const stage of STAGES) {
  const { pushing, prepPayload } = stage;

  describe(`a failed push in ${stage.name}`, () => {
    test("a push that fails before git pushes launches the push once more", () => {
      assert.deepEqual(launched(pushing), { stop: null, ops: [PUSH] });
      const retry = reply(stage, pushing, READ_FAILED);
      assert.deepEqual(launched(retry), { stop: null, ops: [PUSH] });
    });

    test("a retried push that succeeds records the head and prepares the review", () => {
      const prepared = reply(stage, retrying(stage), PUSHED);
      assert.equal(prepared.state.st.headSha, PUSHED_HEAD);
      assert.deepEqual(launched(prepared), {
        stop: null,
        ops: [{ op: "prepare-review", payload: prepPayload }],
      });
    });

    test("a retried push that fails again stops as a step failure", () => {
      const stopped = reply(stage, retrying(stage), READ_FAILED);
      assert.equal(stopped.stop?.code, "error");
      assert.notEqual(stopFor(stopped.stop?.reason)?.code, "push-rejected");
    });

    test("a git push rejection stops as push-rejected, first or retried", () => {
      const first = reply(stage, pushing, REJECTED);
      const retried = reply(stage, retrying(stage), REJECTED);
      for (const stopped of [first, retried]) {
        assert.equal(stopped.stop?.reason, stage.rejected);
        assert.equal(stopCodeOf(stopped), "push-rejected");
      }
    });
  });
}
