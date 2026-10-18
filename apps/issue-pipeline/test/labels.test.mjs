// @ts-check
// The pipeline's label names and the stops' order and codes. GitHub labels and
// the issues already carrying them depend on the names, so a rename updates
// this test too.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

// src after the kit set a temporary root.
const { LABELS } = await import("../src/labels.ts");
const { isStopLabel, STOPS, stopFor } = await import("../src/stops.ts");

test("the status labels keep their names", () => {
  assert.deepEqual(
    Object.values(LABELS).map((label) => label.name),
    ["agent:working", "agent:needs-info", "agent:split", "agent:merged"],
  );
});

// The controls the rewrite removed, with what removed them: the session
// budgets (budget), the fix loop and unrelated-check fixer (fix-loop,
// checks-unrelated), triage (triage-rejected, triage-limit), the spec writer
// and its size and acceptance checks (spec-files, too-large, acceptance).
// Their labels may still sit on issues, so they must still read as stops.
const REMOVED_CODES = [
  "budget",
  "fix-loop",
  "checks-unrelated",
  "triage-rejected",
  "triage-limit",
  "spec-files",
  "too-large",
  "acceptance",
];

test("the stops keep their order and label names", () => {
  assert.deepEqual(
    STOPS.map((stop) => stop.label.name),
    [
      "user-harm",
      "rights",
      "financial-harm",
      "abuse-risk",
      "review-rounds",
      "check-fixes",
      "no-ci",
      "not-doable",
      "branch-changed",
      "wiki-check",
      "conflict",
      "sync-limit",
      "push-rejected",
      "merge-refused",
      "job",
      "error",
    ].map((code) => `agent:stopped-${code}`),
  );
});

test("a removed control's label still reads as a stop, and a status label doesn't", () => {
  const removed = REMOVED_CODES.map((code) => `agent:stopped-${code}`);
  assert.deepEqual(
    removed.filter((name) => !isStopLabel(name)),
    [],
  );
  const status = Object.values(LABELS).map((label) => label.name);
  assert.deepEqual(status.filter(isStopLabel), []);
});

test("a reason maps to its stop, and any other reason to error", () => {
  assert.equal(stopFor("security review (rights) failed")?.code, "rights");
  assert.equal(stopFor("Security Check (user-harm)")?.code, "user-harm");
  assert.equal(stopFor("the push was rejected")?.code, "push-rejected");
  assert.equal(stopFor("blocking findings remain")?.code, "review-rounds");
  assert.equal(stopFor("the checks still fail")?.code, "check-fixes");
  assert.equal(
    stopFor("the implementation changed nothing")?.code,
    "not-doable",
  );
  assert.equal(stopFor("GitHub refused the merge")?.code, "merge-refused");
  assert.equal(
    stopFor("the wiki changes failed the wiki check")?.code,
    "wiki-check",
  );
  assert.equal(
    stopFor("rebasing the wiki onto master conflicts again")?.code,
    "conflict",
  );
  assert.equal(stopFor("the stage job kept dying: review")?.code, "job");
  // A removed control's reason is an error now.
  assert.equal(stopFor("issue token budget exhausted")?.code, "error");
  assert.equal(stopFor("something else")?.code, "error");
});
