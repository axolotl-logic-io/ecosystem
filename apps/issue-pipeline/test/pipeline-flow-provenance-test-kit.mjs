// @ts-check
// One issue through the built orchestrator, jobs, ops and tool extensions.
// Local git origins, pipeline-flow-gh and pipeline-flow-pi fake the services;
// the stages themselves run unchanged, not through direct role calls.
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import { jobLog, tick } from "./pipeline-flow-run-test-kit.mjs";
import {
  authorTurn,
  hardeningTurn,
  implementorTurn,
  openFlowIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script-test-kit.mjs";
import { BASE, refIn, scriptPi } from "./pipeline-flow-test-kit.mjs";

/** @typedef {import("./pipeline-flow-test-kit.mjs").Flow} Flow */

/** @param {Flow} flow @returns {any[]} each pi start, in order */
function piStarts(flow) {
  return piLog(flow.piDir).filter((entry) => entry.start === true);
}

/** @param {Flow} flow @returns {string} */
function baseHead(flow) {
  return String(refIn(flow.origin, `refs/heads/${BASE}`));
}

/**
 * @param {Flow} flow @param {string[]} stages @param {string} stage
 * @returns {Promise<{ started: string[], log: string, state: import("../src/state.ts").IssueState }>}
 */
async function completeStage(flow, stages, stage) {
  const result = await tick(flow);
  stages.push(...result.started);
  if (
    stage === "review" &&
    stages.filter((each) => each === "review").length === 1
  ) {
    const hardened = savedState(readWorld(flow.ghDir));
    withWorld(flow.ghDir, (world) => {
      world.failedHead = hardened.hardened.code;
    });
  }
  const state = savedState(readWorld(flow.ghDir));
  return { started: result.started, log: jobLog(flow), state };
}

/** @param {Flow} flow @param {string} gherkin */
function scriptFlow(flow, gherkin) {
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    author: [authorTurn(gherkin, true)],
    implementor: [implementorTurn("hello, world", "Greet with hello, world")],
    reviewer: [
      implementorTurn("Hello, world", "Hardening capitalizes the greeting"),
      implementorTurn("Hello, world!", "Integration fixes the failed CI check"),
      hardeningTurn(),
      securityTurn(),
    ],
  });
}

export { baseHead, completeStage, piStarts, scriptFlow };
