// @ts-check
// An own-merge interruption fixture with real built jobs/ops and local fakes.
import { z } from "zod";
import { ghCalls } from "./pipeline-flow-gh.mjs";
import { readWorld, withWorld } from "./pipeline-flow-gh-world.mjs";
import {
  BASE,
  ISSUE,
  refIn,
  scriptPi,
  WIKI_BRANCH,
} from "./pipeline-flow-kit.mjs";
import { observeOps, opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { piLog } from "./pipeline-flow-pi.mjs";
import { runStage } from "./pipeline-flow-run.mjs";
import {
  authorTurn,
  implementorTurn,
  openFlowIssue,
  savedState,
} from "./pipeline-flow-script.mjs";

/** @typedef {import("./pipeline-flow-kit.mjs").Flow} Flow */
const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    Then they see a polite greeting";
const INTERRUPTED = { output: {}, rejectPrompt: "read ECONNRESET" };
const STATE_BLOCK = /<!-- agent-pipeline:state\n[\s\S]*?\n-->/u;
const NO_WRITER_OPS = [
  "merge",
  "push",
  "sync-base",
  "wiki-sync",
  "ready-pr",
  "verify",
  "exit-push",
];
const CLAIM = z.object({
  state: z.object({
    codeMerged: z.object({ pr: z.number(), sha: z.string() }),
  }),
});
/** @param {Flow} flow @returns {number} */
function sessions(flow) {
  return piLog(flow.piDir).filter((entry) => entry.start === true).length;
}

/** @param {Flow} flow @returns {string[][]} */
function merges(flow) {
  return ghCalls(flow.ghDir).filter(
    ([command, sub]) => command === "pr" && sub === "merge",
  );
}

/** @param {Flow} flow @param {object} state */
function replaceState(flow, state) {
  withWorld(flow.ghDir, (world) => {
    const comment = world.comments.find(
      ({ issue, body }) => issue === ISSUE && STATE_BLOCK.test(body),
    );
    if (comment === undefined) {
      throw new Error("missing saved state");
    }
    comment.body = comment.body.replace(
      STATE_BLOCK,
      `<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`,
    );
  });
}

/** @param {Flow} flow @param {number} traceStart */
function replayFacts(flow, traceStart) {
  const trace = opsTrace(flow).slice(traceStart);
  const claimed = trace.find(({ request }) => request.op === "claim");
  const { state: claimedState } = CLAIM.parse(claimed?.reply);
  const state = savedState(readWorld(flow.ghDir));
  return {
    claimCodeMerged: claimedState.codeMerged,
    forbidden: trace
      .map(({ request }) => request.op)
      .filter((op) => NO_WRITER_OPS.includes(op)),
    merges: merges(flow).length,
    base: refIn(flow.origin, `refs/heads/${BASE}`),
    hardened: state.hardened,
    integration: state.integration,
    codeMerged: state.codeMerged,
    unsupported: readWorld(flow.ghDir).unsupported,
  };
}

/** @param {Flow} flow */
function createReplayFlow(flow) {
  observeOps(flow);
  const originalWiki = refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`);
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    author: [authorTurn(GHERKIN, true)],
    implementor: [implementorTurn("hello, world", "Developer draft")],
    reviewer: [
      implementorTurn("Hello, world", "Hardening fixes capitalization"),
      implementorTurn("Hello, world!", "Integration fixes CI"),
      INTERRUPTED,
    ],
  });
  for (const stage of ["author", "implement", "review"]) {
    const result = runStage(flow, stage);
    if (result.end !== "next") {
      throw new Error(
        `setup ${stage}: ${JSON.stringify(result)}; ${JSON.stringify(opsTrace(flow).at(-1))}`,
      );
    }
  }
  withWorld(flow.ghDir, (world) => {
    world.failedHead = savedState(world).hardened.code;
  });
  runStage(flow, "merge");
  runStage(flow, "merge");
  const interruptedWorld = readWorld(flow.ghDir);
  return { flow, interruptedWorld, originalWiki };
}

export { createReplayFlow, merges, replaceState, replayFacts, sessions };
