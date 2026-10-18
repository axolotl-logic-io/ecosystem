// @ts-check
// The reviewer's lenses at `--stage review` (#421) when the model provider
// rate-limits them: a transient failure of a session fails the whole
// `sessions` effect, which the runner holds as it holds a single session's
// failure (`rate-limit-defers`). The issue stays saved at review, with no
// lens comment posted and no stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { statusOf } from "./job-test-kit.mjs";
import { CLEAN, reviewJob } from "./reviewer-job-test-kit.mjs";

// The error pi gave the sessions of #303, #304 and #316 at 01:02Z, as in
// job-rate-limit.test.mjs.
const COOLING_DOWN =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model claude-opus-5-5 are cooling down via provider claude"}}';

test("rate-limited lenses hold the review job at review, posting no comment and stopping nothing", () => {
  const held = reviewJob(CLEAN, {}, { rejectPrompt: COOLING_DOWN });
  assert.equal(held.r.status, 0, held.r.stderr);
  assert.deepEqual(held.summary.end, { kind: "held", rateLimited: true });
  assert.deepEqual(held.comments, []);
  assert.deepEqual(held.stops, []);
  assert.equal(held.saved?.stage, "review");
  assert.deepEqual(statusOf(held.place)?.outcome, {
    kind: "finished",
    rateLimited: true,
  });
});
