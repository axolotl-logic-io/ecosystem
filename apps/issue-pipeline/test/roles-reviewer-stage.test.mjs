// @ts-check
// The reviewer role at `--stage review` (#421), from a state today's
// `review` stage saved: each lens on its model with the shared prefix over
// the review bundle, one keyed, signed comment per lens, a clean review saved
// at checks with no sync, blocking findings numbered on and saved at fix (the
// raw ones when the aggregator fails), a failed lens stopping after the
// others' comments, and an empty diff stopping before any session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewStands } from "../src/resume-stage.ts";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import { piStarts, USAGE } from "./job-test-kit.mjs";
import {
  BUNDLE_TEXT,
  CLEAN,
  commonPrefix,
  finding,
  HEAD,
  LENS_NAMES,
  lensReplying,
  modelsOf,
  NEXT_FINDING_ID,
  PATCH_ID,
  PR,
  reviewJob,
  SHA_LENGTH,
  tasksOf,
} from "./reviewer-job-test-kit.mjs";

const OPUS = /opus/u;
const TESTS_FAILED = /tests reviewer failed/u;
// A short sha, as comments name a head.
const SHORT_SHA = 7;
const SONNET = /sonnet/u;
// A finding the correctness and tests lenses both report, merged by the
// aggregator into one.
const NULL_RETURN = finding("blocking", "Null return");
const BLOCKING = {
  "review-correctness": lensReplying([NULL_RETURN]),
  "review-tests": lensReplying([finding("blocking", "Untested null")]),
  "review-scope": lensReplying([]),
  aggregate: [
    messageEnd(USAGE),
    outputEnd({
      blocking: [
        {
          file: "src/a.ts",
          line: 3,
          title: "Null return",
          evidence: "It returns null on an empty list.",
          suggestion: "Return 0.",
          lenses: ["correctness", "tests"],
        },
      ],
    }),
  ],
};
// The tests lens ends with no reply.
const FAILED_LENS = { ...CLEAN, "review-tests": [messageEnd(USAGE)] };
// The aggregator ends with no reply, so the raw findings are numbered.
const UNMERGED = { ...BLOCKING, aggregate: [messageEnd(USAGE)] };
const FALLBACK_ROLE = "aggregator (fallback: raw findings)";

const clean = reviewJob(CLEAN);
const blocking = reviewJob(BLOCKING);
const unmerged = reviewJob(UNMERGED);
const failedLens = reviewJob(FAILED_LENS);
const empty = reviewJob(CLEAN, { changedFiles: [] });

/** @param {readonly { key: string }[]} comments @returns {string[]} their keys, sorted */
function keysOf(comments) {
  return comments.map(({ key }) => key).sort(byText);
}

/** @param {readonly { at: number }[]} comments @returns {number} the last one's place in ops.log */
function lastAt(comments) {
  return Math.max(...comments.map(({ at }) => at));
}

/** @typedef {{ id: string, status: string, title: string, lenses: string[] }} SavedFinding */

/** @param {{ findings: readonly SavedFinding[] }} saved @returns {SavedFinding[]} each saved finding's id, status, title and lenses */
function findingsOf(saved) {
  return saved.findings.map(({ id, status, title, lenses }) => ({
    id,
    status,
    title,
    lenses,
  }));
}

/** @param {string} a @param {string} b @returns {number} */
function byText(a, b) {
  return a.localeCompare(b);
}

const LENS_KEYS = LENS_NAMES.map((lens) => `review-${lens}`).sort(byText);

test("each lens runs on its model, its task the shared prefix over the bundle", () => {
  assert.equal(clean.r.status, 0, clean.r.stderr);
  const models = modelsOf(clean.place);
  assert.match(models["review-correctness"] ?? "", OPUS);
  assert.match(models["review-tests"] ?? "", OPUS);
  assert.match(models["review-scope"] ?? "", SONNET);
  const tasks = tasksOf(clean.place);
  const lensTasks = LENS_NAMES.map((lens) => tasks[`review-${lens}`] ?? "");
  const prefix = commonPrefix(lensTasks);
  assert.ok(prefix.includes(BUNDLE_TEXT), "the shared prefix holds the bundle");
  for (const [index, lens] of LENS_NAMES.entries()) {
    const own = (lensTasks[index] ?? "").slice(prefix.length);
    assert.ok(own.includes(`reviewer (${lens})`), `${lens}'s own part`);
  }
  assert.ok(
    clean.steps.some(
      (/** @type {{ at: string, effect: string }} */ step) =>
        step.at === "lenses" && step.effect === "sessions",
    ),
    "job.json lists the lenses as one sessions step",
  );
});

test("a clean review posts one keyed comment per lens and saves at checks with no sync", () => {
  assert.deepEqual(clean.summary, {
    issue: 7,
    stage: "review",
    end: { kind: "saved", stage: "checks" },
  });
  assert.deepEqual(keysOf(clean.comments), LENS_KEYS);
  for (const { number, by, key, body } of clean.comments) {
    assert.equal(number, PR);
    assert.equal(by.role, `reviewer (${key.slice("review-".length)})`);
    assert.ok(
      body.includes(HEAD.slice(0, SHORT_SHA)),
      "names the reviewed head",
    );
  }
  const correctness = clean.comments.find(
    ({ key }) => key === "review-correctness",
  );
  assert.ok(correctness?.body.includes("Name it plainly"), "lists the nit");
  assert.ok(!clean.ops.some(({ op }) => op === "sync"), "no sync (#340)");
  const { saved } = clean;
  assert.equal(saved.stage, "checks");
  assert.equal(saved.lease, null);
  assert.equal(saved.reviewedSha, HEAD);
  assert.equal(saved.reviewedPatchId, PATCH_ID);
  assert.equal(saved.testsOnly, false);
  assert.deepEqual(saved.findings, []);
});

test("the role's clean review stands on a clean rebase with the same patch id", () => {
  assert.deepEqual(clean.summary?.end, { kind: "saved", stage: "checks" });
  const rebased = {
    remote: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    patchId: PATCH_ID,
    keptUnpushed: false,
    answered: false,
  };
  assert.equal(reviewStands(clean.saved, rebased), true);
  const changed = { ...rebased, patchId: "0".repeat(SHA_LENGTH) };
  assert.equal(reviewStands(clean.saved, changed), false);
});

test("blocking findings are merged, numbered on from the saved number and saved at fix", () => {
  assert.equal(blocking.r.status, 0, blocking.r.stderr);
  assert.deepEqual(blocking.summary.end, { kind: "saved", stage: "fix" });
  const { saved } = blocking;
  assert.equal(saved.reviewedSha, HEAD);
  assert.equal(saved.nextFindingId, NEXT_FINDING_ID + 1);
  assert.deepEqual(findingsOf(saved), [
    {
      id: "f3",
      status: "open",
      title: "Null return",
      lenses: ["correctness", "tests"],
    },
  ]);
  const lensComments = blocking.comments.filter(({ key }) =>
    LENS_KEYS.includes(key),
  );
  assert.deepEqual(keysOf(lensComments), LENS_KEYS);
  const ids = blocking.comments.find(({ by }) => by.role === "aggregator");
  assert.ok(ids?.body.includes("f3"), "the findings comment numbers f3");
  assert.equal(ids?.number, PR);
  assert.ok((ids?.at ?? -1) > lastAt(lensComments), "after the lens comments");
});

test("a failed aggregator's raw findings are numbered on, each with its lens, and saved at fix", () => {
  assert.equal(unmerged.r.status, 0, unmerged.r.stderr);
  assert.deepEqual(unmerged.summary.end, { kind: "saved", stage: "fix" });
  const { saved } = unmerged;
  assert.equal(saved.nextFindingId, NEXT_FINDING_ID + 2);
  assert.deepEqual(findingsOf(saved), [
    { id: "f3", status: "open", title: "Null return", lenses: ["correctness"] },
    { id: "f4", status: "open", title: "Untested null", lenses: ["tests"] },
  ]);
  const roles = unmerged.comments.map(({ by }) => by.role);
  assert.ok(
    !roles.includes("aggregator"),
    "no comment signed as the aggregator",
  );
  const ids = unmerged.comments.find(({ by }) => by.role === FALLBACK_ROLE);
  assert.ok(ids?.body.includes("f3"), "the findings comment numbers f3");
  assert.ok(ids?.body.includes("f4"), "the findings comment numbers f4");
  assert.equal(ids?.number, PR);
});

test("a failed lens stops the issue after the other lenses' comments", () => {
  assert.equal(failedLens.r.status, 0, failedLens.r.stderr);
  assert.deepEqual(failedLens.summary.end, { kind: "stopped", code: "error" });
  assert.deepEqual(keysOf(failedLens.comments), [
    "review-correctness",
    "review-scope",
  ]);
  assert.equal(failedLens.stops.length, 1);
  const [stop] = failedLens.stops;
  assert.equal(stop.reason, "a reviewer failed");
  assert.match(String(stop.detail), TESTS_FAILED);
  const stopAt = failedLens.ops.indexOf(stop);
  assert.ok(stopAt > lastAt(failedLens.comments), "the stop comes last");
});

test("an empty diff stops with nothing to review before any session", () => {
  assert.equal(empty.r.status, 0, empty.r.stderr);
  assert.deepEqual(empty.summary.end, { kind: "stopped", code: "error" });
  assert.deepEqual(piStarts(empty.place), []);
  assert.equal(empty.stops.length, 1);
  assert.equal(empty.stops[0].reason, "nothing to review");
  assert.deepEqual(empty.comments, []);
});
