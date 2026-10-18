// @ts-check
// The stop op through the ops CLI hides IP addresses in what it posts
// (#385): the stop comment and the state comment, whose log saves the stop
// reason, name neither an IPv6 nor an IPv4 address, each with its port, and
// show `[redacted]` in their place.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { bodyOf, stateOf } from "./gh-effects.mjs";
import { kit, v2State } from "./ops-v2-test-kit.mjs";

const { askOps, effects, reply, TIME } = kit;

const STOPPED = { n: 60 };
const STOP_REPLY = z.looseObject({
  state: z.looseObject({ stage: z.string() }),
});
const ADDRESSES = ["2001:db8::1", "192.168.1.10"];
const REASON = "the provider at [2001:db8::1]:443 refused 192.168.1.10:51234";
const REDACTED_REASON = "the provider at [redacted] refused [redacted]";
const DETAIL =
  '{"type":"error","error":{"type":"api_error","message":"upstream [2001:db8::1]:443 rejected 192.168.1.10:51234"}}';

/** @param {string} text @returns {string[]} the addresses `text` names */
function addressesIn(text) {
  return ADDRESSES.filter((address) => text.includes(address));
}

test("a stop whose reason and detail name IP addresses posts neither address", () => {
  const { n } = STOPPED;
  reply([]);
  const request = {
    op: "stop",
    number: n,
    code: "error",
    reason: REASON,
    detail: DETAIL,
    nextStep: null,
    state: v2State(n),
  };
  const stoppedState = {
    ...v2State(n),
    stage: "stopped",
    stoppedStage: "implement",
    stopCode: "error",
    log: [`${TIME} stopped (error): ${REDACTED_REASON}`],
  };
  // The reply goes only to the job that asked, so only what GitHub shows
  // is checked for addresses.
  const { state, ...stop } = STOP_REPLY.parse(askOps(request));
  assert.deepEqual(stop, {
    ok: true,
    op: "stop",
    posted: 0,
    commentIds: [],
    code: "error",
    label: "agent:stopped-error",
  });
  assert.equal(state.stage, "stopped");
  const stopped = effects();
  const body = bodyOf(stopped, `comment #${n} role=coordinator`);
  assert.deepEqual(addressesIn(body), []);
  assert.ok(body.includes(`Reason: ${REDACTED_REASON}`), body);
  assert.ok(
    body.includes("upstream [redacted] rejected [redacted]"),
    "the detail shows [redacted] for each address",
  );
  assert.deepEqual(stateOf(stopped, `comment #${n} state`), stoppedState);
});
