// @ts-check
// Genuine external code merge of the issue's draft, before the pipeline's
// hardening and merge.
import fs from "node:fs";
import path from "node:path";
import { branchMerge } from "./fake-pipeline-flow-gh-merge.mjs";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { observeOps } from "./pipeline-flow-ops-test-kit.mjs";
import { runStage } from "./pipeline-flow-run-test-kit.mjs";
import {
  authorTurn,
  openFlowIssue,
  savedState,
} from "./pipeline-flow-script-test-kit.mjs";
import { BASE, ISSUE, scriptPi, setUpFlow } from "./pipeline-flow-test-kit.mjs";

const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    Then they see a polite greeting";

function externallyMergedFlow() {
  const flow = setUpFlow();
  observeOps(flow);
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  const authored = authorTurn(GHERKIN, true);
  scriptPi(flow, {
    author: [authored],
    implementor: [
      {
        files: { "repo/greet.txt": "Hello, world!\n" },
        commits: [["-am", "Greet visitors"]],
        output: { outcome: "done", summary: "Code merged before hardening" },
      },
    ],
    reviewer: [{ output: {}, rejectPrompt: "read ECONNRESET" }],
  });
  for (const stage of ["author", "implement"]) {
    const result = runStage(flow, stage);
    if (result.end !== "next") {
      throw new Error(`setup ${stage}: ${JSON.stringify(result)}`);
    }
  }
  withWorld(flow.ghDir, (world) => {
    const state = savedState(world);
    if (!state.flows.code) {
      throw new Error("setup must have code");
    }
    const response = branchMerge(world, [
      "repos/o/r/merges",
      "--method",
      "POST",
      "--include",
      "-f",
      `base=${BASE}`,
      "-f",
      `head=${state.headSha}`,
    ]);
    if (response.code !== 0) {
      throw new Error("external merge failed");
    }
    const issue = world.issues.find(({ number }) => number === ISSUE);
    Object.assign(issue ?? {}, { state: "open", stateReason: null });
  });
  return flow;
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @param {import("./fake-pipeline-flow-pi.mjs").FlowTurn[]} turns */
function reviewerTurns(flow, turns) {
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, { reviewer: turns });
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow */
function stateOf(flow) {
  return savedState(readWorld(flow.ghDir));
}

export { externallyMergedFlow, reviewerTurns, stateOf };
