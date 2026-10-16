// @ts-check
// The pipeline's label names and the stops' order and codes. GitHub labels and
// the issues already carrying them depend on the names, so a rename updates
// this test too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LABELS } from "../src/labels.ts";
import { STOPS, stopFor } from "../src/stops.ts";

test("the status labels keep their names", () => {
  assert.deepEqual(
    Object.values(LABELS).map((label) => label.name),
    ["agent:working", "agent:needs-info", "agent:split", "agent:merged"],
  );
});

test("the stops keep their order and label names", () => {
  assert.deepEqual(
    STOPS.map((stop) => stop.label.name),
    [
      "user-harm",
      "rights",
      "financial-harm",
      "abuse-risk",
      "budget",
      "fix-loop",
      "review-rounds",
      "checks-unrelated",
      "check-fixes",
      "no-ci",
      "triage-rejected",
      "triage-limit",
      "not-doable",
      "too-large",
      "acceptance",
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

test("a reason maps to its stop, and any other reason to error", () => {
  assert.equal(stopFor("security review (rights) failed")?.code, "rights");
  assert.equal(stopFor("Security Check (user-harm)")?.code, "user-harm");
  assert.equal(stopFor("the push was rejected")?.code, "push-rejected");
  assert.equal(stopFor("issue token budget exhausted")?.code, "budget");
  assert.equal(stopFor("rebase token budget exhausted")?.code, "budget");
  assert.equal(
    stopFor("the wiki changes failed the wiki check")?.code,
    "wiki-check",
  );
  assert.equal(
    stopFor("rebasing the wiki onto master conflicts again")?.code,
    "conflict",
  );
  assert.equal(stopFor("the stage job kept dying: review")?.code, "job");
  assert.equal(stopFor("something else")?.code, "error");
});
