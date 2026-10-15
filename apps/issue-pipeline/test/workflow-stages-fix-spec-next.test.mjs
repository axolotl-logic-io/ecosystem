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

const SPEC = "## Behaviour\n\n1. The loop visits every item.";

describe("a fix round on an issue with a spec", () => {
  const { begun, prepared } = round(fixState([F1], { spec: SPEC }));

  test("gives the fixer the spec and the rule for disputing against it", () => {
    const { task } = begun.launches[0];
    assert.equal(task, fixTask(1, [F1], "none", SPEC));
    assert.ok(task.includes(SPEC));
  });

  test("gives the re-reviewer the spec and its rule", () => {
    const { task } = prepared.launches[0];
    assert.equal(
      task,
      rereviewTask("correctness", DIFF_PATH, [F1], { spec: SPEC }),
    );
    assert.ok(task.includes(SPEC));
  });
});

for (const [name, spec] of [
  ["no spec", null],
  ["an empty spec", ""],
]) {
  describe(`a fix round on an issue with ${name}`, () => {
    const { begun, prepared } = round(fixState([F1], { spec }));

    test("gives the fixer its task without a spec", () => {
      const { task } = begun.launches[0];
      assert.equal(task, fixTask(1, [F1]));
      assert.ok(!task.includes(SPEC_HEADING));
    });

    test("gives the re-reviewer its task without a spec", () => {
      const { task } = prepared.launches[0];
      assert.equal(task, rereviewTask("correctness", DIFF_PATH, [F1]));
      assert.ok(!task.includes(SPEC_HEADING));
    });
  });
}
