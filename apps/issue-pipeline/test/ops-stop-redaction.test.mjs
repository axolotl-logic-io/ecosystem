// @ts-check
// The stop op through the ops CLI hides IP addresses in what it posts
// (#385): the stop comment and the state comment, whose stop reason it
// saves, name neither an IPv6 nor an IPv4 address, each with its port, and
// show `[redacted]` in their place.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyOf, stateOf } from "./gh-effects.mjs";
import { askOps, effects, reply } from "./ops-cli-test-kit.mjs";

const STOPPED = { n: 60 };
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
    state: { stage: "implement" },
  };
  assert.deepEqual(askOps(request), {
    ok: true,
    op: "stop",
    posted: 0,
    code: "error",
    label: "agent:stopped-error",
  });
  const stopped = effects();
  const body = bodyOf(stopped, `comment #${n} role=coordinator`);
  assert.deepEqual(addressesIn(body), []);
  assert.ok(body.includes(`Reason: ${REDACTED_REASON}`), body);
  assert.ok(
    body.includes("upstream [redacted] rejected [redacted]"),
    "the detail shows [redacted] for each address",
  );
  assert.deepEqual(stateOf(stopped, `comment #${n} state`), {
    stage: "stopped",
    stoppedStage: "implement",
    lease: null,
    stopCode: "error",
    stopReason: REDACTED_REASON,
  });
});
