// Caller clones exist before claim. They must be lane-ready before a model
// starts; failed setup must retain the checkout rather than use defaults.
import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { readWorld } from "./fake-pipeline-flow-gh-world.ts";
import { piLog } from "./fake-pipeline-flow-pi.ts";
import { runStage } from "./pipeline-flow-run-test-kit.ts";
import {
  authorTurn,
  hardeningTurn,
  implementorTurn,
  openFlowIssue,
  savedState,
} from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { scriptPi, setUpFlow } from "./pipeline-flow-test-kit.ts";

const SETTINGS = z.record(z.string(), z.unknown());

function configure(flow: Flow, setup: string, testCommand = "true"): void {
  const settings = SETTINGS.parse(
    JSON.parse(fs.readFileSync(flow.config, "utf8")),
  );
  fs.writeFileSync(
    flow.config,
    JSON.stringify({
      ...settings,
      laneSlots: 1,
      commands: { test: testCommand, setup },
    }),
  );
  openFlowIssue(
    flow,
    "alice",
    "Prepare a lane",
    "Use an isolated test environment.",
  );
}

function jobAttempt(flow: Flow, stage: string): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      path.join(flow.root, "job.mjs"),
      "--config",
      flow.config,
      "--issue",
      "7",
      "--branch",
      "agent/issue-7",
      "--stage",
      stage,
      "--lane",
      "flow-caller",
    ],
    { env: flow.env, encoding: "utf8", timeout: 60_000 },
  );
}

function prepareReview(flow: Flow): void {
  scriptPi(flow, {
    author: [
      authorTurn(
        "Feature: lane\n  Scenario: isolated\n    Then the tests use their lane",
        true,
      ),
    ],
    implementor: [implementorTurn("Hello, lane", "Isolate the tests")],
    reviewer: [hardeningTurn(), hardeningTurn()],
  });
  runStage(flow, "author");
  runStage(flow, "implement");
}

const SETUP_NOT_READY = /lane setup is incomplete|lane setup failed/u;
test("a pre-created caller clone receives its leased setup before its first model session", () => {
  const flow = setUpFlow();
  configure(flow, "printf '%s' \"$ISSUE_PIPELINE_LANE_SLOT\" > assigned-slot");
  const bin = path.join(flow.tmp, "bin");
  const original = path.join(bin, "flow-pi.mjs");
  fs.renameSync(path.join(bin, "pi"), original);
  const observed = path.join(flow.tmp, "session-slot");
  fs.writeFileSync(
    path.join(bin, "pi"),
    `#!${process.execPath}\nimport fs from 'node:fs';\nif (process.argv.includes('--mode')) {\n  const slot = fs.readFileSync('repo/assigned-slot', 'utf8');\n  if (slot !== '1') throw new Error('session checkout is not lane-ready');\n  fs.writeFileSync(${JSON.stringify(observed)}, slot);\n}\nawait import(${JSON.stringify(original)});\n`,
    { mode: 0o755 },
  );
  scriptPi(flow, {
    author: [
      authorTurn(
        "Feature: lane\n  Scenario: isolated tests\n    Then tests use their lane",
        true,
      ),
    ],
  });
  assert.equal(runStage(flow, "author").end, "next");
  assert.equal(fs.readFileSync(observed, "utf8"), "1");
  assert.equal(
    fs.existsSync(path.join(flow.root, "work/o__r/jobs/issue-7-author")),
    false,
  );
});

test("failed caller setup starts no model and preserves its original checkout and signed retry state", () => {
  const flow = setUpFlow();
  configure(flow, "printf 'original' > local-work; exit 2");
  const result = jobAttempt(flow, "author");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, SETUP_NOT_READY);
  const repo = path.join(flow.root, "work/o__r/jobs/issue-7-author/repo");
  assert.equal(
    fs.readFileSync(path.join(repo, "local-work"), "utf8"),
    "original",
  );
  assert.deepEqual(
    piLog(flow.piDir).filter((entry) => entry.start === true),
    [],
  );
  assert.equal(savedState(readWorld(flow.ghDir)).stage, "author");
});

test("failed verification setup retains the primary checkout and starts no check-fix model", () => {
  const flow = setUpFlow();
  configure(
    flow,
    "if [ -e .git/lane-ready ]; then printf 'retained' > local-work; exit 2; fi; touch .git/lane-ready",
  );
  prepareReview(flow);
  const result = jobAttempt(flow, "review");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, SETUP_NOT_READY);
  assert.equal(
    piLog(flow.piDir).filter(
      (entry) => entry.start === true && entry.role === "reviewer",
    ).length,
    1,
  );
  const repo = path.join(flow.root, "work/o__r/jobs/issue-7-review/repo");
  assert.equal(
    fs.readFileSync(path.join(repo, "local-work"), "utf8"),
    "retained",
  );
});

test("successful lane setup keeps ordinary failed-check repair sessions enabled", () => {
  const flow = setUpFlow();
  const failedOnce = path.join(flow.tmp, "failed-once");
  configure(
    flow,
    "true",
    `test -f '${failedOnce}' || { touch '${failedOnce}'; exit 1; }`,
  );
  prepareReview(flow);
  assert.equal(runStage(flow, "review").end, "next");
  assert.equal(
    piLog(flow.piDir).filter(
      (entry) => entry.start === true && entry.role === "reviewer",
    ).length,
    2,
  );
  assert.equal(savedState(readWorld(flow.ghDir)).stage, "merge");
});
