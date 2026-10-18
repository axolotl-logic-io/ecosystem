// @ts-check
// Real built Developer create/save/stop/restart paths, fake pi/GitHub only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readWorld, withWorld } from "./pipeline-flow-gh-world.mjs";
import {
  ISSUE,
  refIn,
  SLUG,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-kit.mjs";
import { observeOps, opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { piLog } from "./pipeline-flow-pi.mjs";
import { runStage } from "./pipeline-flow-run.mjs";
import {
  authorTurn,
  openFlowIssue,
  savedState,
} from "./pipeline-flow-script.mjs";
import { interruptCreation } from "./pr-creation-interruption-test-kit.mjs";

const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    Then they see hello";
const REF = "refs/heads/agent/issue-7";

/** @param {string} repo @param {string[]} args @returns {string} */
function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  }).trim();
}

/** @param {import("./pipeline-flow-kit.mjs").Flow} flow */
function recoveredWork(flow) {
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

/** @param {import("./pipeline-flow-kit.mjs").Flow} flow */
function prepareRestart(flow) {
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

for (const mode of [
  "merged-before-save",
  "interrupted-create",
  "failed-save",
]) {
  test(`${mode}: no writer/code push after external merge; restart discovers exact PR and recovery retains work`, () => {
    const flow = setUpFlow();
    observeOps(flow);
    openFlowIssue(flow, "alice", "Greet politely", "Say hello.");
    scriptPi(flow, { author: [authorTurn(GHERKIN, true)] });
    assert.equal(runStage(flow, "author").end, "next");
    interruptCreation(flow, mode);
    assert.equal(runStage(flow, "implement").end, "stop");
    const captured = JSON.parse(
      fs.readFileSync(path.join(flow.root, "interruption.json"), "utf8"),
    );
    const stopped = savedState(readWorld(flow.ghDir));
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
