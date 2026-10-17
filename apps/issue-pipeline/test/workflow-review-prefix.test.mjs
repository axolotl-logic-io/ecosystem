// @ts-check
// The first reviewers' tasks over a review bundle (#415, the wiki's
// Pipeline-Roles-Reviewer, "First review"): the three lenses' tasks share one
// prefix that holds the bundle, and differ only after it; a prepare-review
// reply without a bundle gets today's diff-path task. Checked for the facts
// the wiki promises, not the prompt's wording.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LENS_NAMES, LENSES } from "../src/workflow/lenses.ts";
import { practicesNote, preamble } from "../src/workflow/prompts.ts";
import { lensTaskShared } from "../src/workflow/stages/review-prefix.ts";
import { lensTask } from "../src/workflow/stages/review-text.ts";
import {
  CFG,
  CTX,
  DIFF,
  ITEM,
  stateWith,
} from "./workflow-review-test-kit.mjs";

/** @import { ReviewBundle } from "../src/workflow/stages/review-prefix.ts" */

const SPEC = "## Behaviour\n\n- The widget counts to three.";
const BUNDLE_TEXT =
  "# Commits, oldest first\n\ncommit abc1234\n\nCount to three\n\n# Diff\n\n+count(3)\n\n# Changed files at the head, in path order\n\n## src/count.ts\n\nexport const three = 3;\n";
/** @type {ReviewBundle} */
const BUNDLE = {
  bundlePath: "/runs/issue-7/review-r0/bundle.md",
  bundleLines: BUNDLE_TEXT.split("\n").length,
  bundleText: BUNDLE_TEXT,
};

// Whether every one of `texts` has `first`'s character at `at`.
/** @param {string[]} texts @param {string} first @param {number} at @returns {boolean} */
function sameAt(texts, first, at) {
  return texts.every((text) => text[at] === first[at]);
}

// The longest text every one of `texts` starts with.
/** @param {string[]} texts @returns {string} */
function commonPrefix(texts) {
  const [first = "", ...rest] = texts;
  let end = 0;
  while (end < first.length && sameAt(rest, first, end)) {
    end += 1;
  }
  return first.slice(0, end);
}

// The three lenses' tasks over BUNDLE, for issue #7 with a spec.
/** @returns {string[]} */
function lensTasks() {
  const state = stateWith("review", { spec: SPEC });
  return LENS_NAMES.map((lens) => lensTaskShared(CTX, state, lens, BUNDLE));
}

test("the correctness, tests and scope tasks share one prefix holding the reviewer rules, the issue, the spec, the practices and the bundle", () => {
  const prefix = commonPrefix(lensTasks());
  // Every line of a reviewer's preamble but its first, which names the role.
  const rules = preamble(CFG, ITEM, "reviewer")
    .slice(1)
    .filter((line) => line !== "");
  for (const fact of [
    ...rules,
    SPEC,
    practicesNote(CFG, ITEM, "reviewer"),
    BUNDLE.bundlePath,
    BUNDLE_TEXT,
  ]) {
    assert.ok(
      prefix.includes(fact),
      `${fact} missing from the prefix:\n${prefix}`,
    );
  }
});

test("each lens's role name and concern come after the shared prefix", () => {
  const tasks = lensTasks();
  const prefix = commonPrefix(tasks);
  for (const lens of LENS_NAMES) {
    assert.ok(!prefix.includes(LENSES[lens]), `${lens}'s concern is shared`);
    assert.ok(
      !prefix.includes(`reviewer (${lens})`),
      `${lens}'s role is shared`,
    );
  }
  LENS_NAMES.forEach((lens, i) => {
    const own = (tasks[i] ?? "").slice(prefix.length);
    assert.ok(own.includes(LENSES[lens]), `${lens}'s concern missing:\n${own}`);
    assert.ok(own.includes(`reviewer (${lens})`), `${lens}'s role missing`);
  });
});

test("a bundle task sends no lens to the diff file: the bundle holds the diff", () => {
  for (const task of lensTasks()) {
    assert.ok(!task.includes("diff.patch"), `diff.patch named in:\n${task}`);
    assert.ok(task.includes(BUNDLE.bundlePath));
  }
});

test("a prepare-review reply without bundlePath gets today's diff-path task", () => {
  const state = stateWith("review", { spec: SPEC });
  const diff = { path: DIFF.path, lines: String(DIFF.lines) };
  for (const lens of LENS_NAMES) {
    assert.equal(
      lensTaskShared(CTX, state, lens, diff),
      lensTask(CTX, state, lens, diff),
    );
  }
});
