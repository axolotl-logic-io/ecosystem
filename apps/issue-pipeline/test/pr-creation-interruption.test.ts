// Real built Developer create/save/stop/restart paths, fake pi/GitHub only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.ts";
import { piLog } from "./fake-pipeline-flow-pi.ts";
import { observeOps, opsTrace } from "./pipeline-flow-ops-test-kit.ts";
import { runStage } from "./pipeline-flow-run-test-kit.ts";
import {
  authorTurn,
  openFlowIssue,
  savedState,
} from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import {
  BASE,
  ISSUE,
  refIn,
  SLUG,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.ts";
import { interruptCreation } from "./pr-creation-interruption-test-kit.ts";

const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    Then they see hello";
const REF = "refs/heads/agent/issue-7";

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  }).trim();
}

function recoveredWork(flow: Flow): {
  restored: string;
  bundles: string[];
  patches: string[];
} {
  const runDir = path.join(flow.root, "runs", SLUG, "issue-7");
  const bundles = fs.readdirSync(path.join(runDir, "recovery"));
  const restored = path.join(flow.tmp, "restored");
  git(flow.tmp, [
    "clone",
    path.join(runDir, "recovery", String(bundles[0])),
    restored,
  ]);
  const patches = fs
    .readdirSync(path.join(runDir, "dropped"))
    .filter((file) => file.endsWith("-repo.patch"));
  git(restored, ["apply", path.join(runDir, "dropped", String(patches[0]))]);
  return { restored, bundles, patches };
}

function prepareRestart(flow: Flow): void {
  withWorld(flow.ghDir, (world) => {
    const issue = world.issues.find((item) => item.number === ISSUE);
    if (issue !== undefined) {
      issue.labels = issue.labels.filter(
        (label) => !label.startsWith("agent:stopped-"),
      );
    }
  });
  scriptPi(flow, {
    implementor: [
      { output: { outcome: "cannot", reason: "operator recovery needed" } },
    ],
  });
}

function openIntegrationFlow(): Flow {
  const flow = setUpFlow();
  // This regression exercises open-issue discovery before the PR was saved,
  // not the closed-Merge exception (which requires a recorded PR). Merge to
  // a non-default integration branch so GitHub leaves the issue open.
  git(flow.origin, [
    "update-ref",
    "refs/heads/main",
    String(refIn(flow.origin, BASE)),
  ]);
  git(flow.origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  observeOps(flow);
  openFlowIssue(flow, "alice", "Greet politely", "Say hello.");
  scriptPi(flow, { author: [authorTurn(GHERKIN, true)] });
  return flow;
}

for (const mode of [
  "merged-before-save",
  "interrupted-create",
  "failed-save",
]) {
  let flow: Flow;
  test(`${mode}: author establishes the create-interruption fixture`, () => {
    flow = openIntegrationFlow();
    assert.equal(runStage(flow, "author").end, "next");
  });
  test(`${mode}: no writer/code push after external merge and recovery retains work`, () => {
    interruptCreation(flow, mode);
    assert.equal(runStage(flow, "implement").end, "stop");
    const captured = JSON.parse(
      fs.readFileSync(path.join(flow.root, "interruption.json"), "utf8"),
    );
    const interrupted = readWorld(flow.ghDir);
    const stopped = savedState(interrupted);
    const issue = interrupted.issues.find((item) => item.number === ISSUE);
    assert.equal(issue?.state, "open");
    assert.equal(captured.before.pr, null);
    assert.equal(captured.before.codeMerged, null);
    assert.equal(stopped.pr, null);
    assert.equal(stopped.codeMerged, null);
    assert.equal(refIn(flow.origin, REF), captured.head);
    assert.notEqual(captured.local, captured.head);
    assert.equal(
      piLog(flow.piDir).filter((entry) => entry.role === "implementor").length,
      0,
    );
    const { restored, bundles, patches } = recoveredWork(flow);
    assert.equal(bundles.length, 1);
    assert.equal(patches.length, 1);
    assert.equal(git(restored, ["rev-parse", "HEAD"]), captured.local);
    assert.equal(
      fs.readFileSync(path.join(restored, "greet.txt"), "utf8"),
      "exact interrupted local C\n",
    );
    assert.equal(
      fs.readFileSync(path.join(restored, "dirty.txt"), "utf8"),
      "exact interrupted dirty work\n",
    );
  });
  test(`${mode}: restart discovers the exact externally merged PR without a code push`, () => {
    const captured = JSON.parse(
      fs.readFileSync(path.join(flow.root, "interruption.json"), "utf8"),
    );
    const restored = path.join(flow.tmp, "restored");
    prepareRestart(flow);
    assert.equal(runStage(flow, "implement").end, "stop");
    const resumed = savedState(readWorld(flow.ghDir));
    const [actual] = readWorld(flow.ghDir).prs;
    assert.equal(
      resumed.pr,
      captured.pr,
      JSON.stringify(opsTrace(flow).at(-1)),
    );
    assert.deepEqual(resumed.codeMerged, {
      pr: captured.pr,
      sha: actual?.mergeOid,
    });
    assert.equal(resumed.merged, null);
    assert.equal(resumed.hardened, null);
    assert.equal(refIn(flow.origin, REF), captured.head);
    assert.equal(git(restored, ["rev-parse", "HEAD"]), captured.local);
    assert.deepEqual(readWorld(flow.ghDir).unsupported, []);
  });
}
