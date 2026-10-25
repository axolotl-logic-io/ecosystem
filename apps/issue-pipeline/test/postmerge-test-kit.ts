// Genuine external code merge of the issue's draft, before the pipeline's
// hardening and merge.
import fs from "node:fs";
import path from "node:path";
import type { IssueState } from "../src/state.ts";
import { branchMerge } from "./fake-pipeline-flow-gh-merge.ts";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.ts";
import type { FlowTurn } from "./fake-pipeline-flow-pi.ts";
import { observeOps } from "./pipeline-flow-ops-test-kit.ts";
import { runStage } from "./pipeline-flow-run-test-kit.ts";
import {
  authorTurn,
  openFlowIssue,
  savedState,
} from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { BASE, ISSUE, scriptPi, setUpFlow } from "./pipeline-flow-test-kit.ts";

const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    Then they see a polite greeting";

function externallyMergedFlow(): Flow {
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
    if (state.flows?.code !== true) {
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

function reviewerTurns(flow: Flow, turns: FlowTurn[]): void {
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, { reviewer: turns });
}

function stateOf(flow: Flow): IssueState {
  return savedState(readWorld(flow.ghDir));
}

export { externallyMergedFlow, reviewerTurns, stateOf };
