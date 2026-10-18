// @ts-check
// A new review cycle zeroes the fix-round count (#418): the implementor
// role's fix entry counts rounds in checkpoints.fixRounds and reads today's
// `round` too, so the review and the security review, which send an issue
// to fix with a fresh round count, zero both. Other checkpoints stay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next as review } from "../src/workflow/stages/review.ts";
import { next as security } from "../src/workflow/stages/security.ts";
import {
  decided,
  stateWith as finishState,
} from "./workflow-finish-test-kit.mjs";
import {
  opReply,
  CTX as REVIEW_CTX,
  stateWith as reviewState,
} from "./workflow-review-test-kit.mjs";

// The counts a finished fix cycle leaves: two rounds, and the implementer's
// continuation.
const USED_ROUNDS = 2;
const USED = { fixRounds: USED_ROUNDS, continuations: 1 };
const LEAK = {
  file: "a.ts",
  line: 3,
  title: "Leaks the token",
  evidence: "It logs the token.",
  suggestion: "Drop the log line.",
  category: "user-harm",
};
const PREPARED = {
  ok: true,
  headSha: "ccccccc",
  diffPath: "/d.diff",
  diffLines: "12",
};

test("a review zeroes the round and the fixRounds checkpoint as it starts, keeping other checkpoints", () => {
  const given = reviewState("review", {
    round: USED_ROUNDS,
    checkpoints: USED,
  });
  const begun = review(given, REVIEW_CTX, []);
  const step = review(begun.state, REVIEW_CTX, [opReply(PREPARED)]);
  const { round, checkpoints } = step.state.st;
  assert.equal(round, 0);
  assert.deepEqual(checkpoints, { ...USED, fixRounds: 0 });
});

test("a security finding sent to fix zeroes the round and the fixRounds checkpoint, keeping other checkpoints", () => {
  const given = finishState("security", {
    round: USED_ROUNDS,
    checkpoints: USED,
  });
  const step = decided(security, given, { findings: [LEAK] });
  const { round, checkpoints, stage } = step.state.st;
  assert.equal(stage, "fix");
  assert.equal(round, 0);
  assert.deepEqual(checkpoints, { ...USED, fixRounds: 0 });
});
