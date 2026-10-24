// @ts-check
// One issue through the built orchestrator, jobs, ops and tool extensions.
// Local git origins, pipeline-flow-gh and pipeline-flow-pi fake the services;
// the stages themselves run unchanged, not through direct role calls.
import fs from "node:fs";
import path from "node:path";
import { ISSUE_STATE } from "../src/state.ts";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { jobLog, tick } from "./pipeline-flow-run-test-kit.mjs";
import {
  authorTurn,
  hardeningTurn,
  implementorTurn,
  openFlowIssue,
  retainAuthoredIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script-test-kit.mjs";
import { BASE, bareGit, refIn, scriptPi } from "./pipeline-flow-test-kit.mjs";

/** @typedef {import("./pipeline-flow-test-kit.mjs").Flow} Flow */
/** @typedef {import("../src/state.ts").IssueState} IssueState */

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
  const checkpoint = savedState(readWorld(flow.ghDir));
  return { started: result.started, log: jobLog(flow), state: checkpoint };
}

/** @param {Flow} flow @param {string} gherkin */
function scriptFlow(flow, gherkin) {
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  retainAuthoredIssue(flow);
  scriptPi(flow, {
    author: [authorTurn(gherkin, true)],
    implementor: [implementorTurn("hello, world", "Greet with hello, world")],
    reviewer: [
      implementorTurn("Hello, world", "Hardening capitalizes the greeting"),
      implementorTurn("Hello, world!", "Hardening fixes the failed CI check"),
      securityTurn(),
    ],
  });
}

/** @param {Flow} flow */
function state(flow) {
  return ISSUE_STATE.parse(savedState(readWorld(flow.ghDir)));
}

/** @param {import("./fake-pipeline-flow-pi.mjs").FlowTurn} interrupted @param {import("./fake-pipeline-flow-pi.mjs").FlowTurn} security @returns {import("./fake-pipeline-flow-pi.mjs").FlowTurn[]} */
function historicalDirectReviewers(interrupted, security) {
  return [
    implementorTurn("Hello, world", "Hardening capitalizes the greeting"),
    implementorTurn("Hello, world!", "Integration fixes CI"),
    hardeningTurn(),
    securityTurn(),
    interrupted,
    security,
  ];
}

const CODE_OPS = new Set(["start-pr", "open-pr", "merge", "push", "sync-base"]);

/** @param {Flow} flow */
function starts(flow) {
  return piLog(flow.piDir).filter((entry) => entry.start === true);
}

/** @param {IssueState} saved */
function evidence(saved) {
  return {
    branch: saved.branch,
    pr: saved.pr,
    headSha: saved.headSha,
    hardened: saved.hardened,
    integration: saved.integration,
    merged: saved.merged,
    mergeAttempt: saved.mergeAttempt,
    security: saved.security,
    requirementsInputs: saved.requirementsInputs,
    authorUsed: saved.authorUsed,
    gherkin: saved.gherkin,
  };
}

/** @param {Flow} flow @param {number} traceStart */
function recoveryFacts(flow, traceStart) {
  const stopped = state(flow);
  const ops = opsTrace(flow)
    .slice(traceStart)
    .map(({ request }) => request.op);
  return {
    stage: stopped.stage,
    stopCode: stopped.stopCode,
    evidence: evidence(stopped),
    codeMerged: stopped.codeMerged,
    refs: bareGit(flow.origin, ["show-ref"]),
    canary: fs.existsSync(path.join(flow.tmp, "forbidden-direct-writer")),
    codeOps: ops.filter((op) => CODE_OPS.has(op)),
    unsupported: readWorld(flow.ghDir).unsupported,
  };
}

/** @param {IssueState} original @param {string} refs */
function expectedRecovery(original, refs) {
  return {
    stage: "stopped",
    stopCode: "error",
    evidence: evidence(original),
    codeMerged: original.codeMerged,
    refs,
    canary: false,
    codeOps: [],
    unsupported: [],
  };
}

export {
  baseHead,
  completeStage,
  expectedRecovery,
  historicalDirectReviewers,
  piStarts,
  recoveryFacts,
  scriptFlow,
  starts,
  state,
};
