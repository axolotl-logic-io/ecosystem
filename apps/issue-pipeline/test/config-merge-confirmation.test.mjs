// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { testConfig } from "./config-test-kit.mjs";

const { mergeConfirmation: defaults } = testConfig().cfg;
const CONFIGURED_SLOW_WAIT_SECONDS = 5;
const THIRD_WAIT_SECONDS = 4;
const FOURTH_WAIT_SECONDS = 8;
const TOO_LONG_WAIT_SECONDS = 61;
const FRACTIONAL_SECONDS = 1.5;

test("confirmation config has safe defaults and refuses unbounded or busy-loop settings", () => {
  assert.deepEqual(defaults, {
    deadlineSeconds: 90,
    backoffSeconds: [1, 2, THIRD_WAIT_SECONDS, FOURTH_WAIT_SECONDS, 10],
  });
  for (const mergeConfirmation of [
    { deadlineSeconds: 0, backoffSeconds: [1] },
    { deadlineSeconds: -1, backoffSeconds: [1] },
    { deadlineSeconds: 601, backoffSeconds: [1] },
    { deadlineSeconds: 1.5, backoffSeconds: [1] },
    { deadlineSeconds: "90", backoffSeconds: [1] },
    { deadlineSeconds: 90, backoffSeconds: [] },
    { deadlineSeconds: 90, backoffSeconds: [0] },
    { deadlineSeconds: 90, backoffSeconds: [-1] },
    { deadlineSeconds: 90, backoffSeconds: [TOO_LONG_WAIT_SECONDS] },
    { deadlineSeconds: 90, backoffSeconds: [FRACTIONAL_SECONDS] },
    {
      deadlineSeconds: 90,
      backoffSeconds: Array.from({ length: 21 }, () => 1),
    },
  ]) {
    assert.throws(() => testConfig({ mergeConfirmation }));
  }
  const { cfg } = testConfig({
    mergeConfirmation: {
      deadlineSeconds: 120,
      backoffSeconds: [2, CONFIGURED_SLOW_WAIT_SECONDS],
    },
  });
  assert.deepEqual(cfg.mergeConfirmation, {
    deadlineSeconds: 120,
    backoffSeconds: [2, CONFIGURED_SLOW_WAIT_SECONDS],
  });
});
