// @ts-check
// The rule against artificial load is a writer rule (#409): no reader's task
// carries it. The readers are triage, the three reviewers and their
// aggregator, the re-reviewer, the check fix's reviewers, the acceptance
// verifier and the security reviewer. The tests build each task from its
// stage and read the text; they run no model, timer or load.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ruleCount } from "./load-rule-test-kit.mjs";
import { READER_SESSIONS } from "./role-sessions-test-kit.mjs";

describe("no reader's task carries the writer rule", () => {
  for (const [who, build] of READER_SESSIONS) {
    test(`${who}`, () => {
      const tasks = build().map(({ task }) => task);
      assert.deepEqual(
        tasks.map(ruleCount),
        tasks.map(() => 0),
        `${who}'s tasks carry the writer rule`,
      );
    });
  }
});
