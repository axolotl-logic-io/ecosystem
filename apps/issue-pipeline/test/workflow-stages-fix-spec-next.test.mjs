// The fix round's step machine (src/workflow/stages/fix.ts and rereview.ts)
// with and without a spec, driven directly with recorded results and a fixed
// clock. These pin that the fixer and re-reviewers see the spec the
// acceptance check judges against, and that their tasks are unchanged without
// one.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DIFF_PATH, F1, fixState, round } from "./workflow-fix-test-kit.mjs";
import {
  fixTask,
  rereviewTask,
  SPEC_HEADING,
} from "./workflow-review-test-kit.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */

const SPEC = "## Behaviour\n\n1. The loop visits every item.";
// A spec clipped in the saved state, and where its full text is (#280).
const CLIPPED = "## Behaviour\n\n1. The clipped copy…";
const SPEC_FILE = "/w/runs/o__r/issue-7/spec.md";
const READ_WHOLE = /Read the whole spec there/u;
/** @type {[name: string, spec: string | null][]} */
const NO_SPECS = [
  ["no spec", null],
  ["an empty spec", ""],
];

// The task of the child `step` launches first.
/** @param {Step} step @returns {string} */
function firstTask(step) {
  if (step.done) {
    throw new Error("the fix round finished before its launch");
  }
  const [launch] = step.launches;
  if (launch.kind !== "child") {
    throw new Error(`the fix round launched ${launch.kind} first`);
  }
  return launch.task;
}

describe("a fix round on an issue with a spec", () => {
  const { begun, prepared } = round(fixState([F1], { spec: SPEC }));

  test("gives the fixer the spec and the rule for disputing against it", () => {
    const task = firstTask(begun);
    assert.equal(task, fixTask(1, [F1], "none", SPEC));
    assert.ok(task.includes(SPEC));
  });

  test("gives the re-reviewer the spec and its rule", () => {
    const task = firstTask(prepared);
    assert.equal(
      task,
      rereviewTask("correctness", DIFF_PATH, [F1], { spec: SPEC }),
    );
    assert.ok(task.includes(SPEC));
  });
});

// Whether `task` names the full spec's path, tells the agent to read it, and
// leaves out the clipped copy.
/** @param {string} task @returns {boolean[]} */
function specFileFacts(task) {
  return [
    task.includes(SPEC_FILE),
    READ_WHOLE.test(task),
    !task.includes(CLIPPED),
  ];
}

describe("a fix round on an issue with a clipped spec", () => {
  const given = { spec: CLIPPED, specFile: SPEC_FILE };
  const { begun, prepared } = round(fixState([F1], given));

  test("gives the fixer the full spec's path, not the clipped copy", () => {
    assert.deepEqual(specFileFacts(firstTask(begun)), [true, true, true]);
  });

  test("gives the re-reviewer the full spec's path, not the clipped copy", () => {
    assert.deepEqual(specFileFacts(firstTask(prepared)), [true, true, true]);
  });
});

for (const [name, spec] of NO_SPECS) {
  describe(`a fix round on an issue with ${name}`, () => {
    const { begun, prepared } = round(fixState([F1], { spec }));

    test("gives the fixer its task without a spec", () => {
      const task = firstTask(begun);
      assert.equal(task, fixTask(1, [F1]));
      assert.ok(!task.includes(SPEC_HEADING));
    });

    test("gives the re-reviewer its task without a spec", () => {
      const task = firstTask(prepared);
      assert.equal(task, rereviewTask("correctness", DIFF_PATH, [F1]));
      assert.ok(!task.includes(SPEC_HEADING));
    });
  });
}
