// @ts-check
// How the workflow cuts text and lists findings in comments and prompts:
// each listed finding holds its facts, checked without copying the wording.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clip } from "../src/workflow/clip.ts";
import { findingLines, findingsText } from "../src/workflow/findings.ts";

/** @import { Finding } from "../src/workflow/types.ts" */

const LIMIT = 5;
const NUMBER = 1_234_567;
// The break between two findings' entries in a list of them.
const FINDING_BREAK = /\n(?=- )/u;

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
// What a listed finding tells its reader, wherever the list appears.
const FACTS = [
  reported.file,
  reported.title,
  reported.evidence,
  reported.suggestion,
];

// The facts of `facts` that `text` leaves out.
/** @param {string} text @param {readonly string[]} facts @returns {string[]} */
function missingFacts(text, facts) {
  return facts.filter((fact) => !text.includes(fact));
}

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
  const text = findingLines([reported]);
  assert.deepEqual(missingFacts(text, FACTS), []);
  assert.equal(text.includes("undefined"), false);
  // The same finding listed with an id is longer by its id marker.
  assert.ok(text.length < findingLines([numbered]).length);
});

test("a review comment lists numbered findings with their ids", () => {
  const lines = findingLines([numbered, { ...reported, id: "f4", line: 2 }]);
  const [first = "", second = ""] = lines.split(FINDING_BREAK);
  assert.deepEqual(missingFacts(first, ["f3", "src/a.ts:12", ...FACTS]), []);
  assert.deepEqual(missingFacts(second, ["f4", "src/a.ts:2", ...FACTS]), []);
});

test("a prompt lists a finding with its evidence and suggestion", () => {
  assert.deepEqual(
    missingFacts(findingsText([numbered]), ["f3", "src/a.ts:12", ...FACTS]),
    [],
  );
});

test("a prompt lists a security finding's category and the fixer's dispute", () => {
  /** @type {Finding} */
  const disputed = { ...numbered, category: "rights", dispute: "It is <." };
  const [first = "", second = ""] = findingsText([disputed, numbered]).split(
    FINDING_BREAK,
  );
  assert.deepEqual(
    missingFacts(first, ["f3", "rights", "It is <.", ...FACTS]),
    [],
  );
  assert.deepEqual(missingFacts(second, ["f3", ...FACTS]), []);
  assert.equal(second.includes("rights"), false);
  assert.equal(second.includes("It is <."), false);
});
