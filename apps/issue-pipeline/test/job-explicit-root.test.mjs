// @ts-check
// An explicit caller needs no discovery/sweep prerequisite on a fresh root.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import { readWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import { withoutCoordination } from "./pipeline-flow-coordination-test-kit.mjs";
import { runStage } from "./pipeline-flow-run-test-kit.mjs";
import {
  authorTurn,
  implementorTurn,
  openFlowIssue,
  savedState,
} from "./pipeline-flow-script-test-kit.mjs";
import { ISSUE, SLUG, scriptPi, setUpFlow } from "./pipeline-flow-test-kit.mjs";

const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    Then they see hello";

function newIssue() {
  const flow = setUpFlow();
  openFlowIssue(flow, "alice", "Greet politely", "Say hello.");
  scriptPi(flow, {
    author: [authorTurn(GHERKIN, true)],
    implementor: [implementorTurn("Hello", "Greet politely")],
  });
  return flow;
}

test("fresh explicit Author initializes metadata once; Developer interruption and restart reuse the mirror without a sweep", () => {
  const flow = newIssue();
  const clone = path.join(flow.root, "clones", SLUG);
  assert.equal(fs.existsSync(clone), false);
  assert.equal(runStage(flow, "author").end, "next");
  const git = path.join(clone, ".git");
  const identity = fs.statSync(git).ino;
  const marker = path.join(git, "preserved-test-marker");
  fs.writeFileSync(marker, "preserve existing clone");
  scriptPi(flow, {
    implementor: [
      { output: {}, rejectPrompt: "read ECONNRESET" },
      implementorTurn("Hello", "Greet politely"),
    ],
  });
  assert.equal(runStage(flow, "implement").end, "deferred");
  assert.equal(runStage(flow, "implement").end, "next");
  assert.equal(fs.statSync(git).ino, identity);
  assert.equal(fs.readFileSync(marker, "utf8"), "preserve existing clone");
  assert.equal(
    savedState(readWorld(flow.ghDir)).branch,
    `agent/issue-${ISSUE}`,
  );
  assert.equal(
    ghCalls(flow.ghDir).some(
      ([command, sub]) => command === "issue" && sub === "list",
    ),
    false,
  );
  assert.deepEqual(readWorld(flow.ghDir).unsupported, []);
});

test("metadata clone failure before claim leaves no lease, model, live job or control socket", () => {
  const flow = newIssue();
  const clones = path.join(flow.root, "clones");
  fs.mkdirSync(clones);
  const obstruction = path.join(clones, SLUG);
  fs.writeFileSync(obstruction, "unrelated preserved file");
  const result = runStage(flow, "author");
  assert.equal(result.end, "unclaimed");
  assert.equal(
    fs.readFileSync(obstruction, "utf8"),
    "unrelated preserved file",
  );
  assert.deepEqual(piLog(flow.piDir), []);
  // Only the job's own ownership records precede its claim (#167); the
  // refused claim holds them for reconciliation.
  assert.deepEqual(withoutCoordination(readWorld(flow.ghDir)).comments, []);
  assert.deepEqual(
    readWorld(flow.ghDir).issues.find(({ number }) => number === ISSUE)?.labels,
    [],
  );
  const run = path.join(flow.root, "runs", SLUG, `issue-${ISSUE}`);
  const status = JSON.parse(
    fs.readFileSync(path.join(run, "job.json"), "utf8"),
  );
  assert.ok(status.endedAt !== null);
  assert.equal(fs.existsSync(status.socket), false);
  assert.throws(() => process.kill(status.pid, 0));
  assert.equal(
    fs.existsSync(
      path.join(flow.root, "work", SLUG, "jobs", `issue-${ISSUE}-author`),
    ),
    false,
  );
});
