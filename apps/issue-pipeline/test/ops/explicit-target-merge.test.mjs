// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  calls,
  consumed,
  mergedView,
  post,
  prechecks,
  prStep,
  request,
  resultInputs,
  script,
} from "../explicit-target-test-kit.mjs";
import {
  BASE,
  BRANCH,
  git,
  ISSUE,
  PR,
  REPO,
  world,
} from "../explicit-target-world-test-kit.mjs";
import { effectsOf } from "../gh-effects-test-kit.mjs";
import { confirmationClock } from "./confirmation-clock-test-kit.mjs";

const { merge } = await import("../../src/ops/merge.ts");
const { mergedCode } = await import("../../src/ops/merged-review.ts");
const { verify } = await import("../../src/ops/verify.ts");
const { gh } = await import("../../src/github.ts");
const REFUSED = z.looseObject({ merged: z.literal(false), reason: z.string() });
const INVALID_REQUEST = /bad merge request/u;
const SHA_LENGTH = 40;
const IDENTITY = /not the configured repository|not from|not agent|targets/u;

const SHORT_SHA_LENGTH = 12;
function mergerComments() {
  return effectsOf(calls()).filter(
    ({ effect }) => effect === `comment #${PR} role=merger`,
  );
}
/** @param {import("../explicit-target-world-test-kit.mjs").World} w */
function receiptSteps(w) {
  return [prStep(w, mergedView(w), true), prStep(w, mergedView(w), true)];
}
/** @returns {string[][]} */
function mutations() {
  return calls().filter(
    (args) => args.includes("POST") && !args.includes("event=APPROVE"),
  );
}

test("literal configured integration and full H survive a concurrent source branch move", () => {
  const w = world();
  script(w, [
    ...prechecks(w),
    post(w, {
      updates: [
        [`refs/heads/${BASE}`, w.merged],
        [`refs/heads/${BRANCH}`, w.moved],
      ],
    }),
    prStep(w, mergedView(w)),
    prStep(w, mergedView(w), true),
    ...resultInputs(w),
  ]);
  assert.deepEqual(merge(w.cfg, request(w), confirmationClock()), {
    merged: true,
    mergeCommit: w.merged,
    headSha: w.head,
  });
  assert.equal(git(w.origin, ["rev-parse", "main"]), w.base);
  assert.equal(git(w.origin, ["rev-parse", BRANCH]), w.moved);
  assert.equal(
    git(w.origin, ["show", "-s", "--format=%P", w.merged]),
    `${w.parent} ${w.head}`,
  );
  assert.equal(
    mutations().filter((args) => args[1] === `repos/${REPO}/merges`).length,
    1,
  );
  const comments = mergerComments();
  assert.equal(comments.length, 1);
  assert.ok(comments[0]?.body.includes(w.merged.slice(0, SHORT_SHA_LENGTH)));
  consumed();
});

test("main is a valid configured source base, not an implicit production exclusion", () => {
  const original = world();
  const w = { ...original, cfg: { ...original.cfg, baseBranch: "main" } };
  script(w, [
    ...prechecks(w),
    post(w),
    prStep(w, mergedView(w)),
    prStep(w, mergedView(w), true),
    ...resultInputs(w),
  ]);
  assert.deepEqual(merge(w.cfg, request(w), confirmationClock()), {
    merged: true,
    mergeCommit: w.merged,
    headSha: w.head,
  });
  assert.equal(git(w.origin, ["rev-parse", "main"]), w.merged);
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
  assert.equal(
    mutations().filter((args) => args[1] === `repos/${REPO}/merges`).length,
    1,
  );
  const comments = mergerComments();
  assert.equal(comments.length, 1);
  assert.ok(comments[0]?.body.includes(w.merged.slice(0, SHORT_SHA_LENGTH)));
  consumed();
});

test("a main-source configuration refuses a PR targeting another branch before approval or merge", () => {
  const original = world();
  const w = { ...original, cfg: { ...original.cfg, baseBranch: "main" } };
  script(w, [prStep(w, { baseRefName: BASE })]);
  assert.throws(() => merge(w.cfg, request(w)), IDENTITY);
  assert.equal(git(w.origin, ["rev-parse", "main"]), w.base);
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
  assert.equal(
    calls().some((args) => args.includes("event=APPROVE")),
    false,
  );
  assert.equal(mutations().length, 0);
  consumed();
});

test("PR retarget during the request cannot select main and stops after landing without a false receipt", () => {
  const w = world();
  script(w, [
    ...prechecks(w),
    post(w),
    ...Array.from({ length: 3 }, () =>
      prStep(w, { ...mergedView(w), baseRefName: "main" }),
    ),
  ]);
  assert.match(
    REFUSED.parse(merge(w.cfg, request(w), confirmationClock())).reason,
    IDENTITY,
  );
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.merged);
  assert.equal(git(w.origin, ["rev-parse", "main"]), w.base);
  assert.equal(mutations().length, 1);
  consumed();
});

test("concurrent integration contribution is checked and security reads detached actual M with the entire multi-commit contribution", () => {
  const w = world({ concurrent: true });
  script(w, [
    ...prechecks(w),
    post(w),
    prStep(w, mergedView(w)),
    prStep(w, mergedView(w), true),
    ...resultInputs(w),
  ]);
  assert.equal(merge(w.cfg, request(w), confirmationClock()).merged, true);
  const comments = mergerComments();
  assert.equal(comments.length, 1);
  assert.ok(comments[0]?.body.includes(w.merged.slice(0, SHORT_SHA_LENGTH)));
  consumed();
  script(w, receiptSteps(w));
  const verified = verify(
    {
      ...w.cfg,
      commands: {
        test: "test -f concurrent.txt && test -f early.txt && test -f late.txt && test ! -f moved.txt",
      },
    },
    { number: ISSUE, codeMerged: { pr: PR, sha: w.merged } },
  );
  assert.equal(verified.pass, true);
  assert.equal(verified.headSha, w.merged);
  assert.deepEqual(verified.changedFiles, ["early.txt", "late.txt"]);
  consumed();
  script(w, receiptSteps(w));
  const reviewed = mergedCode(w.cfg, ISSUE, { pr: PR, sha: w.merged });
  assert.deepEqual(reviewed.files, ["early.txt", "late.txt"]);
  assert.deepEqual(reviewed.range, { from: w.parent, head: w.merged });
  assert.equal(git(w.wt, ["rev-parse", "HEAD"]), w.merged);
  assert.equal(
    fs.readFileSync(path.join(w.wt, "concurrent.txt"), "utf8"),
    "concurrent integration contribution\n",
  );
  assert.ok(reviewed.diff.includes("earlier feature commit"));
  assert.ok(reviewed.diff.includes("last feature commit"));
  assert.equal(mutations().length, 0);
  consumed();
});

test("unlisted fake reads and writes deny without changing the private origin", () => {
  const w = world();
  script(w, []);
  for (const args of [
    ["api", "unlisted"],
    ["pr", "merge", String(PR)],
    ["api", `repos/${REPO}/merges`, "-X", "POST"],
  ]) {
    assert.notEqual(gh(w.cfg, "merge", args, { allowFail: true }).code, 0);
  }
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
});

for (const head of [
  "HEAD",
  "1234",
  "a".repeat(SHA_LENGTH - 1),
  "a".repeat(SHA_LENGTH + 1),
  "A".repeat(SHA_LENGTH),
]) {
  test(`non-full immutable authorized SHA ${head} is refused before any gh call`, () => {
    const w = world();
    script(w, []);
    const req = request(w);
    assert.throws(
      () => merge(w.cfg, { ...req, expectedSha: head }, confirmationClock()),
      INVALID_REQUEST,
    );
    assert.deepEqual(calls(), []);
  });
}

test("a previously MERGED PR returns observed external truth without another mutation", () => {
  const w = world();
  script(w, [prStep(w, mergedView(w))]);
  assert.deepEqual(merge(w.cfg, request(w), confirmationClock()), {
    merged: true,
    byHand: true,
    mergeCommit: w.merged,
    headSha: w.head,
  });
  assert.equal(mutations().length, 0);
  consumed();
});

test("HTTP204 after another actor landed H never fabricates an own receipt or repeats mutation", () => {
  const w = world();
  script(w, [
    ...prechecks(w),
    post(w, { stdout: "HTTP/2.0 204 No Content\r\n\r\n" }),
  ]);
  const reply = REFUSED.parse(merge(w.cfg, request(w), confirmationClock()));
  assert.ok(reply.reason.includes("no fresh own receipt"));
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.merged);
  assert.equal(mutations().length, 1);
  consumed();
});
