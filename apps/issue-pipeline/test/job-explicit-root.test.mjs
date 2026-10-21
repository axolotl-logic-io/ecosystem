// @ts-check
// An explicit caller needs no discovery/sweep prerequisite on a fresh root.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import { readWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
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
const RUN_MS = 60_000;

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @param {string[]} extra */
function startAuthor(flow, extra) {
  return spawnSync(
    process.execPath,
    [
      path.join(flow.root, "job.mjs"),
      "--config",
      flow.config,
      "--issue",
      String(ISSUE),
      "--stage",
      "author",
      "--branch",
      `agent/issue-${ISSUE}`,
      ...extra,
    ],
    { env: flow.env, encoding: "utf8", timeout: RUN_MS },
  );
}

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

test("invalid branch and a missing prompt page refuse before any mirror, claim or model exists", () => {
  const flow = newIssue();
  const branch = startAuthor(flow, ["--branch", "integration"]);
  assert.equal(branch.status, 1);
  assert.ok(branch.stderr.includes("is the base branch"));
  const page = path.join(flow.prompts, "author.md");
  fs.renameSync(page, `${page}-unavailable`);
  const missing = startAuthor(flow, []);
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes(`can't read prompt page ${page}`));
  for (const dir of ["clones", "mirrors", "work"]) {
    assert.equal(fs.existsSync(path.join(flow.root, dir)), false);
  }
  assert.deepEqual(ghCalls(flow.ghDir), []);
  assert.deepEqual(piLog(flow.piDir), []);
  assert.deepEqual(readWorld(flow.ghDir).comments, []);
});

test("a boundary print pins pages but initializes no clone or claim", () => {
  const flow = newIssue();
  const boundary = startAuthor(flow, ["--print-boundary"]);
  assert.equal(boundary.status, 0, boundary.stderr);
  assert.equal(fs.existsSync(path.join(flow.root, "clones")), false);
  assert.equal(fs.existsSync(path.join(flow.root, "work")), false);
  assert.deepEqual(ghCalls(flow.ghDir), []);
  assert.deepEqual(piLog(flow.piDir), []);
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
  assert.deepEqual(readWorld(flow.ghDir).comments, []);
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
