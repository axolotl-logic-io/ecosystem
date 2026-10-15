// The exact text of the pipeline's labels and stops. GitHub labels and the
// issues already carrying them depend on it, so the move to src/labels.ts and
// src/stops.ts (#166) must not change a character.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { LABELS } from "../src/labels.ts";
import { STOPS, stopFor } from "../src/stops.ts";

// The sha256 of every label and stop row's text, including each stop's regex
// source, computed from ops.mjs's LABELS and STOPS before #166.
const TEXT_DIGEST =
  "e770d2c96f2f4bee8d456c7decaef63c68f48c1768ccfd1b36807ed16e29b62c";

function rowsText() {
  return JSON.stringify({
    labels: LABELS,
    stops: STOPS.map((stop) => ({
      code: stop.code,
      short: stop.short,
      test: stop.test.source,
      control: stop.control,
      explain: stop.explain,
      label: stop.label,
    })),
  });
}

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
      "conflict",
      "sync-limit",
      "push-rejected",
      "merge-refused",
      "error",
    ].map((code) => `agent:stopped-${code}`),
  );
});

test("every label and stop keeps its exact text", () => {
  assert.equal(
    createHash("sha256").update(rowsText()).digest("hex"),
    TEXT_DIGEST,
  );
});

test("a reason maps to its stop, and any other reason to error", () => {
  assert.equal(stopFor("security review (rights) failed")?.code, "rights");
  assert.equal(stopFor("Security Check (user-harm)")?.code, "user-harm");
  assert.equal(stopFor("the push was rejected")?.code, "push-rejected");
  assert.equal(stopFor("issue token budget exhausted")?.code, "budget");
  assert.equal(stopFor("rebase token budget exhausted")?.code, "budget");
  assert.equal(stopFor("something else")?.code, "error");
});
