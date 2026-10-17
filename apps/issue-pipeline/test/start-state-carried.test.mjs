// @ts-check
// What startState carries over a stop's restart: the spec's files, which the
// orchestrator's file holds read, and its full-text path; the PR's
// description; the tokens the issue's sessions reported; and, when the review
// stands, the counter that numbers the next finding.
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
const FILES = ["apps/web/src/chats/**", "apps/web/drizzle/**"];
const SPEC_FILE = "/runs/issue-7/spec.md";
const PR_BY = { agent: "implementer", model: "m", run: "r" };
const TOKENS = 225_171;
const NEXT_FINDING = 3;
// The issue stopped at checks after the branch changed outside the pipeline.
const stopped = {
  version: 1,
  number: 7,
  depth: 1,
  pr: PR,
  headSha: "h1",
  reviewedSha: "h1",
  stage: "stopped",
  stoppedStage: "checks",
  stopCode: "branch-changed",
  plan: "P",
  spec: "S",
  specFile: SPEC_FILE,
  files: FILES,
  prTitle: "T",
  prBody: "B",
  prBy: PR_BY,
  reportedTokens: TOKENS,
  findings: [{ id: "f1", status: "resolved" }],
  nextFindingId: NEXT_FINDING,
  log: ["a"],
};
const ctx = {
  n: 7,
  depth: 1,
  remote: "h2",
  pr: PR,
  hasWork: true,
  keptUnpushed: false,
  answered: false,
  now: new Date("2026-10-16T23:43:00Z"),
};

test("a branch-changed stop's restart at review keeps the spec's files and full-text path", () => {
  const { stage, files, specFile, spec } = startState(stopped, ctx);
  assert.deepEqual(
    { stage, files, specFile, spec },
    { stage: "review", files: FILES, specFile: SPEC_FILE, spec: "S" },
  );
});

test("a restart at review keeps the PR's description and the reported tokens", () => {
  const { prTitle, prBody, prBy, reportedTokens } = startState(stopped, ctx);
  assert.deepEqual(
    { prTitle, prBody, prBy, reportedTokens },
    { prTitle: "T", prBody: "B", prBy: PR_BY, reportedTokens: TOKENS },
  );
});

test("a standing review keeps the counter that numbers the next finding", () => {
  const { stage, nextFindingId } = startState(stopped, {
    ...ctx,
    remote: "h1",
  });
  assert.deepEqual([stage, nextFindingId], ["checks", NEXT_FINDING]);
});

test("a review that doesn't stand starts the findings and their numbers again", () => {
  const restarted = startState(stopped, ctx);
  assert.deepEqual(
    [restarted.findings, "nextFindingId" in restarted],
    [[], false],
  );
});

test("answered questions with work drop the spec's files with the spec", () => {
  const restarted = startState(
    { ...stopped, stage: "triage", questionsAt: "x" },
    { ...ctx, answered: true },
  );
  const { reportedTokens } = restarted;
  assert.deepEqual(
    ["files" in restarted, "specFile" in restarted, reportedTokens],
    [false, false, TOKENS],
  );
});

test("a too-large stop's restart at implement keeps the reported tokens", () => {
  const { stage, reportedTokens } = startState(
    { ...stopped, stopCode: "too-large", stoppedStage: "implement" },
    ctx,
  );
  assert.deepEqual([stage, reportedTokens], ["implement", TOKENS]);
});

test("a restart adds no key the stopped state lacked", () => {
  const { files: _f, specFile: _s, prTitle: _t, ...bare } = stopped;
  const restarted = startState(bare, ctx);
  assert.deepEqual(
    ["files" in restarted, "specFile" in restarted, "prTitle" in restarted],
    [false, false, false],
  );
});
