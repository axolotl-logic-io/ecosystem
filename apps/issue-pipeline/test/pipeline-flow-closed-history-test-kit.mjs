// @ts-check
// Seed only this pre-upgrade recovery subject; modern replay delivery stays FF.
import fs from "node:fs";
import path from "node:path";
import { ISSUE_STATE } from "../src/state.ts";
import { branchMerge } from "./fake-pipeline-flow-gh-merge.mjs";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import {
  prepareReplayFlow,
  replaceState,
} from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, runThroughTasks } from "./pipeline-flow-run-test-kit.mjs";
import { savedState } from "./pipeline-flow-script-test-kit.mjs";
import { BASE, bareGit } from "./pipeline-flow-test-kit.mjs";

/** @typedef {import("./pipeline-flow-test-kit.mjs").Flow} Flow */

/** @param {Flow} flow */
function historicalIntegration(flow) {
  const parent = bareGit(flow.origin, ["rev-parse", `refs/heads/${BASE}`]);
  prepareReplayFlow(flow);
  const setup = ["author", "implement", "review"].map(
    (stage) => runStage(flow, stage).end,
  );
  const reviewed = ISSUE_STATE.parse(savedState(readWorld(flow.ghDir)));
  const { hardened } = reviewed;
  if (hardened === null || hardened.code === null) {
    throw new Error("missing original historical hardening");
  }
  const head = hardened.code;
  withWorld(flow.ghDir, (world) => {
    world.failedHead = head;
  });
  // Merge relays its Integration request, then CI fails on the first head:
  // Hardening fixes it as R2. The pre-upgrade integration receipt this
  // fixture seeds is built from those two real revisions, as the legacy
  // writable integration once wrote it (#186 retired that writer).
  setup.push(runThroughTasks(flow, "merge").at(-1)?.end);
  setup.push(runStage(flow, "review").end);
  const fixed = ISSUE_STATE.parse(savedState(readWorld(flow.ghDir)));
  if (fixed.hardened === null) {
    throw new Error("missing the fixed hardening");
  }
  const integrated = ISSUE_STATE.parse({
    ...fixed,
    integration: { reviewed: hardened, revision: fixed.hardened },
  });
  return { parent, reviewed, integrated, setup };
}

/** @param {Flow} flow */
function createClosedHistoricalFlow(flow) {
  const { parent, reviewed, integrated, setup } = historicalIntegration(flow);
  const { integration, pr, branch } = integrated;
  if (
    integration === null ||
    pr === null ||
    branch === null ||
    integration.revision.code === null
  ) {
    throw new Error("missing original historical integration identity");
  }
  const authorized = integration.revision;
  const response = withWorld(flow.ghDir, (world) =>
    branchMerge(world, [
      `repos/${world.repo}/merges`,
      "--method",
      "POST",
      "--include",
      "-f",
      `base=${BASE}`,
      "-f",
      `head=${authorized.code}`,
    ]),
  );
  const result = bareGit(flow.origin, ["rev-parse", `refs/heads/${BASE}`]);
  const historical = ISSUE_STATE.parse({
    ...integrated,
    stage: "merge",
    mergeReturn: null,
    hardened: reviewed.hardened,
    hardenedTarget: reviewed.hardenedTarget,
    integration,
    security: null,
    merged: { ...authorized, code: result },
    codeMerged: { pr, sha: result },
    mergeAttempt: {
      repo: "o/r",
      pr,
      target: BASE,
      branch,
      authorized,
      hardened: reviewed.hardened,
      integration,
      result,
      reads: 1,
    },
  });
  replaceState(flow, historical);
  fs.unlinkSync(path.join(flow.root, "interrupt-finish"));
  return { parent, reviewed, integrated, historical, setup, response };
}

export { createClosedHistoricalFlow };
