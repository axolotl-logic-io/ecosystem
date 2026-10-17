// @ts-check
// review-keeps-on-clean-rebase (#394): each review that passes the branch's
// head records the patch id of its changes (reviewedPatchId), from the
// prepare-review reply it reviewed: the lenses' review with no blocking
// finding, a fix round's re-review that leaves none open, and a CI fix's
// review. A review with blocking findings records none. Driven directly, as
// the stages' -next tests drive the rest.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next as checksNext } from "../src/workflow/stages/checks.ts";
import { next as reviewNext } from "../src/workflow/stages/review.ts";
import {
  after,
  replied as checksReplied,
  sessionResult,
  stateAt,
} from "./workflow-checks-test-kit.mjs";
import {
  DIFF_PATH,
  FIXED,
  fixState,
  round,
  verdict,
} from "./workflow-fix-test-kit.mjs";
import {
  CTX,
  DIFF,
  OFF_BY_ONE,
  opReply,
  replied,
  stateWith,
} from "./workflow-review-test-kit.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */
/** @import { IssueState } from "../src/workflow/types.ts" */
// A saved state, with the field #394 adds.
/** @typedef {Partial<IssueState> & { reviewedPatchId?: string | null }} Fields */

// The patch id of the head's changes, as prepare-review replies it, and the
// one an earlier review recorded.
const PATCH = "9a7c9a7c9a7c9a7c9a7c9a7c9a7c9a7c9a7c9a7c";
const EARLIER = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const HEAD = "ccccccc";
const LENS_NAMES = ["correctness", "tests", "scope"];
const BLOCKING = { severity: "blocking", ...OFF_BY_ONE };
/** @type {{ findings: unknown[] }} */
const NO_FINDINGS = { findings: [] };
const FAILING = {
  ok: true,
  headSha: "cccccccccccccccc",
  pass: false,
  checks: [{ id: "test", pass: false, detail: "1 failed", tail: "3 != 2" }],
};

// The patch id a saved state records as reviewed.
/** @param {Fields} st @returns {unknown} */
function reviewedPatchOf(st) {
  return st.reviewedPatchId;
}

// The review's step after its reviewers reply, correctness with `findings`,
// on a diff whose changes have PATCH, from a state saved with `fields`.
/** @param {unknown[]} findings @param {Fields} fields @returns {Step} */
function reviewed(findings, fields) {
  const begun = reviewNext(stateWith("review", fields), CTX, []);
  const prepared = {
    ok: true,
    headSha: HEAD,
    diffPath: DIFF.path,
    diffLines: DIFF.lines,
    patchId: PATCH,
  };
  const started = reviewNext(begun.state, CTX, [opReply(prepared)]);
  const results = LENS_NAMES.map((lens) => {
    let output = NO_FINDINGS;
    if (lens === "correctness") {
      output = { findings };
    }
    return replied(`review-${lens}`, output);
  });
  return reviewNext(started.state, CTX, results);
}

/** @type {Fields} */
const EARLIER_REVIEW = { reviewedPatchId: EARLIER };

test("a review with no blocking finding records the patch id it reviewed", () => {
  const step = reviewed([], EARLIER_REVIEW);
  const { st } = step.state;
  assert.deepEqual(
    [st.stage, st.reviewedSha, reviewedPatchOf(st)],
    ["checks", HEAD, PATCH],
  );
});

test("a review with a blocking finding records no new patch id", () => {
  const step = reviewed([BLOCKING], EARLIER_REVIEW);
  assert.equal(reviewedPatchOf(step.state.st), EARLIER);
});

// The prep's reply in a fix round, for changes with PATCH.
const ROUND_PREP = { ok: true, diffPath: DIFF_PATH, patchId: PATCH };

test("a re-review that leaves no finding open records the patch id of the fixed head", () => {
  const given = fixState(undefined, EARLIER_REVIEW);
  const { settled } = round(given, FIXED, {}, ROUND_PREP);
  const { st } = settled.state;
  assert.deepEqual([st.stage, reviewedPatchOf(st)], ["checks", PATCH]);
});

test("a re-review that leaves a finding open records no new patch id", () => {
  const given = fixState(undefined, EARLIER_REVIEW);
  const unresolved = replied(
    "rereview-correctness-r1",
    verdict("f1", "unresolved"),
  );
  const rereviews = { "rereview-correctness-r1": unresolved };
  const { settled } = round(given, FIXED, rereviews, ROUND_PREP);
  const { st } = settled.state;
  assert.deepEqual([st.stage, reviewedPatchOf(st)], ["fix", EARLIER]);
});

// The step after a CI fix's lenses reply, correctness with `findings`, on a
// diff whose changes have PATCH.
/** @param {unknown[]} findings @returns {Step} */
function ciFixReviewed(findings) {
  /** @type {Fields} */
  const fields = EARLIER_REVIEW;
  const begun = checksNext(stateAt("checks", fields), CTX, []);
  const fixing = checksReplied(checksNext, begun, FAILING);
  const fix = sessionResult("cifix-1", { status: "fixed", summary: "Fixed." });
  const pushing = after(checksNext, fixing, CTX, fix);
  const fixedHead = { ok: true, headSha: "ffffffffffffffff" };
  const preparing = checksReplied(checksNext, pushing, fixedHead);
  const prep = { ok: true, diffPath: "/w/d.diff", patchId: PATCH };
  const reviewing = checksReplied(checksNext, preparing, prep);
  return after(
    checksNext,
    reviewing,
    CTX,
    sessionResult("cifix-review-correctness-1", { findings }),
    sessionResult("cifix-review-scope-1", NO_FINDINGS),
  );
}

test("a CI fix's review with no blocking finding records the patch id it reviewed", () => {
  const saving = ciFixReviewed([]);
  assert.equal(reviewedPatchOf(saving.state.st), PATCH);
});

test("a CI fix's review with a blocking finding records no new patch id", () => {
  const stopped = ciFixReviewed([BLOCKING]);
  assert.notEqual(stopped.stop, null);
  assert.equal(reviewedPatchOf(stopped.state.st), EARLIER);
});
