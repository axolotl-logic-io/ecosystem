// @ts-check
// startState for an issue stopped at publish, after its PR merged (#216): it
// resumes at publish, keeping its state but for the conflict limits and the
// stop, not at review.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { setEnv } from "./ops-run-test-kit.mjs";

const d = fs.mkdtempSync("/tmp/issue-pipeline-test-");
process.on("exit", () => fs.rmSync(d, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
setEnv("ISSUE_PIPELINE_ROOT", d);
const { startState } = await import("../src/start-state.ts");

const PR = 50;
const stopped = {
  number: 7,
  depth: 1,
  pr: PR,
  headSha: "h1",
  allocated: 990_000,
  conflictFixes: 2,
  log: ["a"],
  stage: "stopped",
  stoppedStage: "publish",
  stopCode: "conflict",
  stopReason: "conflict limit",
  rebaseAllocated: 40_000,
  syncs: 3,
  findings: [{ id: "f1", status: "resolved" }],
  sessions: [{ role: "writer" }],
  spec: "the spec",
};
// The merged PR is closed, and the wiki branch still holds the issue's work.
const start = {
  n: 7,
  depth: 1,
  remote: null,
  pr: null,
  hasWork: true,
  keptUnpushed: false,
  answered: false,
  now: new Date("2026-10-15T03:00:00Z"),
};

test("an issue stopped at publish resumes there, resetting only the conflict limits and the stop", () => {
  const state = startState(stopped, start);
  assert.deepEqual(state, {
    ...stopped,
    stage: "publish",
    conflictFixes: 0,
    rebaseAllocated: 0,
    stopCode: null,
    stopReason: null,
    log: [
      "a",
      "2026-10-15T03:00Z restarted at publish after the conflict stop; conflict limits reset",
    ],
  });
});

test("an issue stopped at publish with answered questions does not resume at publish", () => {
  const state = startState(stopped, { ...start, answered: true });
  assert.notEqual(state.stage, "publish");
});

test("an issue stopped before publish still restarts at review", () => {
  const state = startState({ ...stopped, stoppedStage: "checks" }, start);
  assert.equal(state.stage, "review");
});
