// @ts-check
// The lenses' cache order (#421): of the lenses on one model, the first
// starts at once and the next once the first has printed its first
// `message_end`, so it reads the shared prefix from the prompt cache; a first
// lens that ends with none still lets the next start. The lens on the other
// model starts at once. The fake pi's marks and holds order the lenses by
// what they wait for, not by a clock: the first Opus lens (correctness)
// holds until the Sonnet lens (scope) has started, and, in the first run,
// until the second Opus lens (tests) has started, so the run can only end
// if both start while it runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import { logOf, USAGE } from "./job-test-kit.mjs";
import {
  launchName,
  lensReplying,
  reviewJob,
} from "./reviewer-job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

const SCOPE = [{ fakeMark: "scope-started" }, ...lensReplying([])];
const TESTS = [{ fakeMark: "tests-started" }, ...lensReplying([])];
const AFTER_MESSAGE_END = reviewJob({
  "review-scope": SCOPE,
  "review-tests": TESTS,
  "review-correctness": [
    { fakeHold: "scope-started" },
    { fakeMark: "correctness-turn" },
    messageEnd(USAGE),
    { fakeHold: "tests-started" },
    outputEnd({ findings: [] }),
  ],
});
const NO_MESSAGE_END = reviewJob({
  "review-scope": SCOPE,
  "review-tests": TESTS,
  "review-correctness": [
    { fakeHold: "scope-started" },
    { fakeMark: "correctness-done" },
    outputEnd({ findings: [] }),
  ],
});

/**
 * Where in pi.log `what` happened: a launch's start, by its name, or a mark.
 * @param {Place} place
 * @param {{ start: string } | { mark: string }} what
 * @returns {number} its line, or -1
 */
function lineOf(place, what) {
  return logOf(place, "pi.log").findIndex((entry) => {
    if ("mark" in what) {
      return entry.mark === what.mark;
    }
    if (!("argv" in entry)) {
      return false;
    }
    return launchName(entry.argv) === what.start;
  });
}

test("the second Opus lens starts after the first's first message_end, the Sonnet lens at once", () => {
  const { place, r, summary } = AFTER_MESSAGE_END;
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(summary?.end, { kind: "saved", stage: "checks" });
  const turn = lineOf(place, { mark: "correctness-turn" });
  const correctness = lineOf(place, { start: "review-correctness" });
  const scope = lineOf(place, { start: "review-scope" });
  const tests = lineOf(place, { start: "review-tests" });
  assert.ok(correctness >= 0 && scope >= 0 && turn >= 0);
  assert.ok(scope < turn, "the Sonnet lens started before the first turn");
  assert.ok(tests > turn, "the second Opus lens waited for message_end");
});

test("a first Opus lens that ends with no message_end still lets the second start", () => {
  const { place, r, summary } = NO_MESSAGE_END;
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(summary?.end, { kind: "saved", stage: "checks" });
  const done = lineOf(place, { mark: "correctness-done" });
  const tests = lineOf(place, { start: "review-tests" });
  assert.ok(done >= 0);
  assert.ok(tests > done, "the second Opus lens started after the first");
});
