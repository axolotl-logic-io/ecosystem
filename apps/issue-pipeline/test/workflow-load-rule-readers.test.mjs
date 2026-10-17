// @ts-check
// The rule against artificial load is a writer rule (#409): no reader's task
// carries it. The readers are triage, the three reviewers and their
// aggregator, the re-reviewer, the check fix's reviewers, the acceptance
// verifier and the security reviewer. The tests build each task from its
// stage and read the text; they run no model, timer or load.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { next as accept } from "../src/workflow/stages/accept.ts";
import { next as checks } from "../src/workflow/stages/checks.ts";
import { next as review } from "../src/workflow/stages/review.ts";
import { next as security } from "../src/workflow/stages/security.ts";
import { next as triage } from "../src/workflow/stages/triage.ts";
import { ruleCount, taskOf, tasksOf } from "./load-rule-test-kit.mjs";
import {
  after,
  CTX as CHECKS_CTX,
  replied as checksReplied,
  sessionResult,
  stateAt,
} from "./workflow-checks-test-kit.mjs";
import {
  stateWith as finishState,
  prepared,
} from "./workflow-finish-test-kit.mjs";
import { fixState, round } from "./workflow-fix-test-kit.mjs";
import {
  OFF_BY_ONE,
  opReply,
  CTX as REVIEW_CTX,
  replied as reviewReplied,
  stateWith as reviewState,
} from "./workflow-review-test-kit.mjs";
import {
  CTX as TRIAGE_CTX,
  stateWith as triageState,
} from "./workflow-triage-test-kit.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */

const HEAD = "cccccccccccccccc";
const FIXED_HEAD = "ffffffffffffffff";
const FAILING = {
  ok: true,
  headSha: HEAD,
  pass: false,
  checks: [{ id: "test", pass: false, detail: "1 failed", tail: "3 != 2" }],
};
const REVIEW_DIFF = {
  ok: true,
  headSha: "ccccccc",
  diffPath: "/w/review.diff",
  diffLines: 12,
};

// The review's step once its lenses are launched.
/** @returns {Step} */
function lensesLaunched() {
  const begun = review(reviewState("review"), REVIEW_CTX, []);
  return review(begun.state, REVIEW_CTX, [opReply(REVIEW_DIFF)]);
}

// The review's step once the lenses reported one blocking finding, which
// launches the aggregator.
/** @returns {Step} */
function aggregatorLaunched() {
  const lenses = lensesLaunched();
  const blocking = { findings: [{ severity: "blocking", ...OFF_BY_ONE }] };
  const results = ["correctness", "tests", "scope"].map((lens) => {
    if (lens === "correctness") {
      return reviewReplied(`review-${lens}`, blocking);
    }
    return reviewReplied(`review-${lens}`, { findings: [] });
  });
  return review(lenses.state, REVIEW_CTX, results);
}

// Checks' step once a CI fix is pushed and its diff prepared, which launches
// the check fix's reviewers.
/** @returns {Step} */
function checkFixReviewersLaunched() {
  const begun = checks(stateAt("checks"), CHECKS_CTX, []);
  const fixing = checksReplied(checks, begun, FAILING);
  const fixed = sessionResult("cifix-1", { status: "fixed", summary: "Done." });
  const pushing = after(checks, fixing, CHECKS_CTX, fixed);
  const preparing = checksReplied(checks, pushing, {
    ok: true,
    headSha: FIXED_HEAD,
  });
  return checksReplied(checks, preparing, { ok: true, diffPath: "/w/d.diff" });
}

// Each reader's tasks, built by its stage as the pipeline builds them.
/** @type {ReadonlyArray<readonly [string, () => string[]]>} */
const READER_TASKS = [
  ["triage", () => tasksOf(triage(triageState(), TRIAGE_CTX, []))],
  ["the reviewers", () => tasksOf(lensesLaunched())],
  ["the aggregator", () => tasksOf(aggregatorLaunched())],
  ["the re-reviewer", () => tasksOf(round(fixState()).prepared)],
  ["the check fix's reviewers", () => tasksOf(checkFixReviewersLaunched())],
  [
    "the acceptance verifier",
    () => [taskOf(prepared(accept, finishState("accept")))],
  ],
  [
    "the security reviewer",
    () => [taskOf(prepared(security, finishState("security")))],
  ],
];

describe("no reader's task carries the writer rule", () => {
  for (const [who, build] of READER_TASKS) {
    test(`${who}`, () => {
      const tasks = build();
      assert.deepEqual(
        tasks.map(ruleCount),
        tasks.map(() => 0),
        `${who}'s tasks carry the writer rule`,
      );
    });
  }
});
