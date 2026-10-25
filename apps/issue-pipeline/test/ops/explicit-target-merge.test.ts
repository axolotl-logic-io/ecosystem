import assert from "node:assert/strict";
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
} from "../explicit-target-test-kit.ts";
import {
  BASE,
  BRANCH,
  git,
  PR,
  REPO,
  world,
} from "../explicit-target-world-test-kit.ts";
import type { GhEffect } from "../gh-effects-test-kit.ts";
import { effectsOf } from "../gh-effects-test-kit.ts";
import { confirmationClock } from "./confirmation-clock-test-kit.ts";

const { merge }: typeof import("../../src/ops/merge.ts") = await import(
  "../../src/ops/merge.ts"
);
const { gh }: typeof import("../../src/github.ts") = await import(
  "../../src/github.ts"
);
const REFUSED = z.looseObject({ merged: z.literal(false), reason: z.string() });
const INVALID_REQUEST = /bad merge request/u;
const SHA_LENGTH = 40;
const INITIAL_REVISION_READS = 5;
const IDENTITY = /not the configured repository|not from|not agent|targets/u;

const SHORT_SHA_LENGTH = 12;
function mergerComments(): GhEffect[] {
  return effectsOf(calls()).filter(
    ({ effect }) => effect === `comment #${PR} role=merger`,
  );
}
function mutations(): string[][] {
  return calls().filter((args) => args[0] === "git" && args.includes("push"));
}

test("literal configured integration and full H survive a concurrent source branch move", () => {
  const w = world({ fastForward: true });
  script(w, [
    ...prechecks(w),
    post(w, {
      updates: [
        [`refs/heads/${BASE}`, w.merged],
        [`refs/heads/${BRANCH}`, w.moved],
      ],
    }),
    prStep(w, mergedView(w)),
    ...resultInputs(w),
  ]);
  assert.deepEqual(merge(w.cfg, request(w), confirmationClock()), {
    merged: true,
    mergeCommit: w.merged,
    headSha: w.head,
  });
  assert.equal(git(w.origin, ["rev-parse", "main"]), w.base);
  assert.equal(git(w.origin, ["rev-parse", BRANCH]), w.moved);
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.head);
  assert.equal(mutations().length, 1);
  const comments = mergerComments();
  assert.equal(comments.length, 1);
  assert.ok(comments[0]?.body.includes(w.merged.slice(0, SHORT_SHA_LENGTH)));
  consumed();
});

test("main is a valid configured source base, not an implicit production exclusion", () => {
  const w = world({ baseBranch: "main", fastForward: true });
  script(w, [
    ...prechecks(w),
    post(w),
    prStep(w, mergedView(w)),
    ...resultInputs(w),
  ]);
  assert.deepEqual(merge(w.cfg, request(w), confirmationClock()), {
    merged: true,
    mergeCommit: w.merged,
    headSha: w.head,
  });
  assert.equal(git(w.origin, ["rev-parse", "main"]), w.merged);
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
  assert.equal(mutations().length, 1);
  const comments = mergerComments();
  assert.equal(comments.length, 1);
  assert.ok(comments[0]?.body.includes(w.merged.slice(0, SHORT_SHA_LENGTH)));
  consumed();
});

test("a main-source configuration refuses a PR targeting another branch before approval or merge", () => {
  const w = world({ baseBranch: "main", fastForward: true });
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
  const w = world({ fastForward: true });
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

test("concurrent integration contribution requires resync, checks and review rather than a different merge result", () => {
  const w = world({ concurrent: true });
  git(w.origin, ["update-ref", `refs/heads/${BASE}`, w.parent]);
  script(w, prechecks(w).slice(0, INITIAL_REVISION_READS));
  assert.deepEqual(merge(w.cfg, request(w), confirmationClock()), {
    merged: false,
    reason: "target-changed",
  });
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.parent);
  assert.equal(mutations().length, 0);
  assert.equal(
    calls().some((args) => args.includes("event=APPROVE")),
    false,
  );
  consumed();
});

test("unlisted fake reads and writes deny without changing the private origin", () => {
  const w = world({ fastForward: true });
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
    const w = world({ fastForward: true });
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
  const w = world({ fastForward: true });
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

test("lost push acknowledgement reconciles only the exact intended target without a mutation retry", () => {
  const w = world({ fastForward: true });
  script(w, [
    ...prechecks(w),
    post(w, { code: 1, stderr: "response lost" }),
    prStep(w, mergedView(w)),
    ...resultInputs(w),
  ]);
  assert.deepEqual(merge(w.cfg, request(w), confirmationClock()), {
    merged: true,
    mergeCommit: w.head,
    headSha: w.head,
  });
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.head);
  assert.equal(mutations().length, 1);
  consumed();
});
