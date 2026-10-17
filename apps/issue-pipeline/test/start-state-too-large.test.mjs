// @ts-check
// startState after a too-large stop: the restart resumes the stage that
// stopped, implement, which reads the handoff, keeping the branch's PR and
// head and not going back through triage (`every-role-resumes`). Without a
// spec it is specified first. Other stops resume where they stopped too.
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

test("a specced too-large stop with work resumes implement, not triage", () => {
  const { stage, pr, headSha, spec, continuations } = startState(
    { ...stopped, stopCode: "too-large", spec: "S", continuations: { i: 2 } },
    ctx,
  );
  assert.deepEqual(
    [stage, pr, headSha, spec, continuations],
    ["implement", PR, REMOTE, "S", {}],
  );
});

test("a too-large stop at implement with no spec goes to spec", () => {
  const { stage } = startState({ ...stopped, stopCode: "too-large" }, ctx);
  assert.equal(stage, "spec");
});

test("a not-doable stop with work resumes the stage that stopped", () => {
  const { stage } = startState(
    { ...stopped, stopCode: "not-doable", spec: "S" },
    ctx,
  );
  assert.equal(stage, "implement");
});
