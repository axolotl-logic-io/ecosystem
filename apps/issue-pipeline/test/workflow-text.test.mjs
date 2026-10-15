// @ts-check
// How the workflow cuts text and lists findings in comments and prompts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clip } from "../src/workflow/clip.ts";
import { findingLines, findingsText } from "../src/workflow/findings.ts";

/** @import { Finding } from "../src/workflow/types.ts" */

const LIMIT = 5;
const NUMBER = 1_234_567;

const reported = {
  file: "src/a.ts",
  line: 12,
  title: "Off by one",
  evidence: "The loop stops early.",
  suggestion: "Use <=.",
};
/** @type {Finding} */
const numbered = {
  ...reported,
  id: "f3",
  lenses: ["correctness"],
  category: null,
  status: "open",
  disputed: false,
};

test("clip leaves short text unchanged", () => {
  assert.equal(clip("short", LIMIT), "short");
  assert.equal(clip("", LIMIT), "");
});

test("clip reads null and undefined as empty text", () => {
  assert.equal(clip(null, LIMIT), "");
  assert.equal(clip(undefined, LIMIT), "");
});

test("clip cuts long text at the limit with an ellipsis", () => {
  assert.equal(clip("longer text", LIMIT), "longe…");
  assert.equal(clip(NUMBER, LIMIT), "12345…");
});

test("a review comment lists a reported finding without an id", () => {
  assert.equal(
    findingLines([reported]),
    "- `src/a.ts:12` Off by one\n  The loop stops early.\n  Suggested: Use <=.",
  );
});

test("a review comment lists numbered findings with their ids", () => {
  assert.equal(
    findingLines([numbered, { ...reported, id: "f4", line: 2 }]),
    [
      "- **f3** `src/a.ts:12` Off by one\n  The loop stops early.\n  Suggested: Use <=.",
      "- **f4** `src/a.ts:2` Off by one\n  The loop stops early.\n  Suggested: Use <=.",
    ].join("\n"),
  );
});

test("a prompt lists a finding with its evidence and suggestion", () => {
  assert.equal(
    findingsText([numbered]),
    "- f3 [src/a.ts:12] Off by one\n  Evidence: The loop stops early.\n  Suggestion: Use <=.",
  );
});

test("a prompt lists a security finding's category and the fixer's dispute", () => {
  /** @type {Finding} */
  const disputed = { ...numbered, category: "rights", dispute: "It is <." };
  assert.equal(
    findingsText([disputed, numbered]),
    [
      "- f3 (security: rights) [src/a.ts:12] Off by one\n  Evidence: The loop stops early.\n  Suggestion: Use <=.\n  Fixer's dispute: It is <.",
      "- f3 [src/a.ts:12] Off by one\n  Evidence: The loop stops early.\n  Suggestion: Use <=.",
    ].join("\n"),
  );
});
