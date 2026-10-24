// @ts-check
// Scenario steps shared by the real-flow own-merge replay and closed-race
// recovery tests: the replay's setup stages, rewinding the cleared own FF
// merge to its saved receipt, and an installed-caller recovery that must be
// refused.
import { isStateBody } from "../src/comment-marks.ts";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import {
  readWorld,
  withWorld,
  writeWorld,
} from "./fake-pipeline-flow-gh-world.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { replaceState, sessions } from "./pipeline-flow-replay-test-kit.mjs";
import {
  runCallerStage,
  runStage,
  runThroughTasks,
} from "./pipeline-flow-run-test-kit.mjs";
import { savedState } from "./pipeline-flow-script-test-kit.mjs";
import { BASE, ISSUE, refIn } from "./pipeline-flow-test-kit.mjs";

/** @typedef {import("./pipeline-flow-test-kit.mjs").Flow} Flow */
/** @typedef {import("./fake-pipeline-flow-gh-world.mjs").World} World */

const MUTATION_ARGS = new Set([
  "POST",
  "PATCH",
  "DELETE",
  "reopen",
  "close",
  "edit",
  "create",
]);

/**
 * The replay's setup stages before its interrupted merge: the first
 * hardened head fails CI, so merge (after the Integration it requests, which
 * the setup relays) returns it to Hardening, which fixes it.
 */
const REPLAY_SETUP = [
  { stage: "author", end: "next", action: "none" },
  { stage: "implement", end: "next", action: "none" },
  { stage: "review", end: "next", action: "fail-ci" },
  { stage: "merge", end: "next", action: "relay" },
  { stage: "review", end: "next", action: "integration" },
];

/**
 * Runs one setup stage. The fixture's pre-activation integration receipt is
 * built from the two real hardened revisions (pipeline-flow-replay-test-kit
 * historicalMerge): the one whose CI failed and the one Hardening fixed.
 * @param {Flow} flow
 * @param {{ stage: string, action: string }} step
 * @param {{ integration?: import("../src/state.ts").Integration, reviewed?: import("../src/state.ts").Revision }} setup
 * @returns {string}
 */
function completeSetupStage(flow, { stage, action }, setup) {
  let end = "";
  if (action === "relay") {
    end = runThroughTasks(flow, stage).at(-1)?.end ?? "";
  } else {
    ({ end } = runStage(flow, stage));
  }
  if (action === "fail-ci") {
    withWorld(flow.ghDir, (world) => {
      setup.reviewed = savedState(world).hardened;
      world.failedHead = savedState(world).hardened.code;
    });
  }
  if (action === "integration" && setup.reviewed !== undefined) {
    const { hardened } = savedState(readWorld(flow.ghDir));
    setup.integration = { reviewed: setup.reviewed, revision: hardened };
  }
  return end;
}

/**
 * The genuine cleared own merge rewound to its saved receipt at Merge,
 * before completion, with `extra` state.
 * @param {Flow} flow @param {World} clearedWorld @param {Record<string, unknown>} [extra]
 */
function restoreClearedReceipt(flow, clearedWorld, extra = {}) {
  writeWorld(flow.ghDir, structuredClone(clearedWorld));
  replaceState(flow, {
    ...savedState(clearedWorld),
    stage: "merge",
    ...extra,
  });
}

/** @param {Flow} flow */
function recoverySnapshot(flow) {
  return {
    world: readWorld(flow.ghDir),
    head: refIn(flow.origin, `refs/heads/${BASE}`),
    branch: refIn(flow.origin, `refs/heads/agent/issue-${ISSUE}`),
    sessions: sessions(flow),
  };
}

/**
 * The installed caller's merge on `interruptedWorld` with `extra` state, or
 * none: its result, what it saw and changed, its ops and GitHub writes.
 * @param {Flow} flow
 * @param {World} interruptedWorld
 * @param {Record<string, unknown> | null} extra
 */
async function refusedRecovery(flow, interruptedWorld, extra) {
  writeWorld(flow.ghDir, structuredClone(interruptedWorld));
  withWorld(flow.ghDir, (world) => {
    world.withholdMergeBinding = false;
    if (extra === null) {
      world.comments = world.comments.filter(({ body }) => !isStateBody(body));
    }
  });
  if (extra !== null) {
    replaceState(flow, { ...savedState(interruptedWorld), ...extra });
  }
  const before = recoverySnapshot(flow);
  const beforeCalls = ghCalls(flow.ghDir).length;
  const beforeTrace = opsTrace(flow).length;
  const result = await runCallerStage(flow, "merge");
  return {
    result,
    before,
    after: recoverySnapshot(flow),
    ops: opsTrace(flow)
      .slice(beforeTrace)
      .map(({ request }) => request.op),
    writes: ghCalls(flow.ghDir)
      .slice(beforeCalls)
      .filter((args) => args.some((arg) => MUTATION_ARGS.has(arg))),
  };
}

export {
  completeSetupStage,
  REPLAY_SETUP,
  refusedRecovery,
  restoreClearedReceipt,
};
