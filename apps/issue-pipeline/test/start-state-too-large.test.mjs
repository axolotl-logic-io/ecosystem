// @ts-check
// startState after a too-large stop: the restart goes to triage, which reads
// the handoff, and keeps the branch's PR and head even when the branch holds
// work (#283). Other stops with work still restart at review.
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
const REMOTE = "h2";
const stopped = {
  version: 1,
  number: 7,
  depth: 1,
  pr: PR,
  headSha: "h1",
  stage: "stopped",
  stoppedStage: "implement",
  log: ["a"],
};
const ctx = {
  n: 7,
  depth: 1,
  remote: REMOTE,
  pr: PR,
  hasWork: true,
  keptUnpushed: false,
  answered: false,
  now: new Date("2026-10-16T03:00:00Z"),
};

test("a too-large stop with work on the branch restarts at triage (#283)", () => {
  const { stage, pr, headSha } = startState(
    { ...stopped, stopCode: "too-large" },
    ctx,
  );
  assert.deepEqual([stage, pr, headSha], ["triage", PR, REMOTE]);
});

test("a not-doable stop with work on the branch still restarts at review", () => {
  const { stage } = startState({ ...stopped, stopCode: "not-doable" }, ctx);
  assert.equal(stage, "review");
});
