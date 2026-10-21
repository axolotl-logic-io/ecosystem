// @ts-check
// An own-merge interruption fixture with real built jobs/ops and local fakes.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import { nativeTargetUpdates } from "./fake-pipeline-flow-gh-native.mjs";
import {
  readWorld,
  withWorld,
  writeWorld,
} from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import { observeOps, opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { runStage } from "./pipeline-flow-run-test-kit.mjs";
import {
  authorTurn,
  hardeningTurn,
  implementorTurn,
  openFlowIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script-test-kit.mjs";
import { BASE, ISSUE, refIn, scriptPi } from "./pipeline-flow-test-kit.mjs";

/** @typedef {import("./pipeline-flow-test-kit.mjs").Flow} Flow */
const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    Then they see a polite greeting";
const SECURITY_TAG_LENGTH = 12;

/** @param {Flow} flow @param {string} code */
function securityEvidence(flow, code) {
  const launch = piLog(flow.piDir)
    .filter((entry) => entry.start === true)
    .at(-1);
  const tag = `review-security-${code.slice(0, SECURITY_TAG_LENGTH)}`;
  const diff = fs.readFileSync(
    path.join(flow.root, "runs", "o__r", `issue-${ISSUE}`, tag, "diff.patch"),
    "utf8",
  );
  return { launch, diff };
}
/** @param {Flow} flow @param {string} mergedSha @returns {{ diff: string, bundle: string, files: string }} */
function securityBundle(flow, mergedSha) {
  const tag = `review-security-${mergedSha.slice(0, SECURITY_TAG_LENGTH)}`;
  const dir = path.join(flow.root, "runs", "o__r", `issue-${ISSUE}`, tag);
  const diff = fs.readFileSync(path.join(dir, "diff.patch"), "utf8");
  const bundle = fs.readFileSync(path.join(dir, "bundle.md"), "utf8");
  return { diff, bundle, files: bundle.slice(diff.length) };
}

const STATE_BLOCK = /<!-- agent-pipeline:state\n[\s\S]*?\n-->/u;
const NO_WRITER_OPS = ["merge", "push", "sync-base", "ready-pr", "exit-push"];
const VERIFIED = z.object({ pass: z.boolean(), headSha: z.string() });
const CLAIM = z.object({
  state: z.object({
    codeMerged: z.object({ pr: z.number(), sha: z.string() }),
  }),
});
/** @param {import("./fake-pipeline-flow-gh-world.mjs").World} world */
function expectedTargetUpdates(world) {
  const { mergeAttempt } = savedState(world);
  return [
    {
      origin: world.origin,
      ref: `refs/heads/${mergeAttempt.target}`,
      old: mergeAttempt.operation.base,
      head: mergeAttempt.authorized.code,
    },
  ];
}

/** @param {import("./fake-pipeline-flow-gh-world.mjs").World} interruptedWorld @param {boolean} [checked] */
function expectedReplay(interruptedWorld, checked = true) {
  const state = savedState(interruptedWorld);
  const codeMerged = { pr: state.pr, sha: state.merged.code };
  /** @type {{ pass: boolean, headSha: string }[]} */
  let verified = [];
  if (checked) {
    verified = [{ pass: true, headSha: state.merged.code }];
  }
  return {
    claimCodeMerged: codeMerged,
    forbidden: [],
    merges: 0,
    targetUpdates: expectedTargetUpdates(interruptedWorld),
    verified,
    base: state.merged.code,
    mergeAttempt: state.mergeAttempt,
    hardenedTarget: state.hardenedTarget,
    hardened: state.hardened,
    integration: state.integration,
    codeMerged,
    unsupported: [],
  };
}

/** @param {Flow} flow @returns {number} */
function sessions(flow) {
  return piLog(flow.piDir).filter((entry) => entry.start === true).length;
}

/** @param {Flow} flow @returns {string[][]} */
function merges(flow) {
  return ghCalls(flow.ghDir).filter(
    ([command, endpoint]) =>
      command === "api" && endpoint === "repos/o/r/merges",
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

/** @param {Flow} flow @param {import("./fake-pipeline-flow-gh-world.mjs").World} world */
function restoreReplay(flow, world) {
  writeWorld(flow.ghDir, structuredClone(world));
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, {
    reviewer: [{ output: {}, rejectPrompt: "read ECONNRESET" }],
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
    targetUpdates: nativeTargetUpdates(readWorld(flow.ghDir)),
    verified: trace
      .filter(({ request }) => request.op === "verify")
      .map(({ reply }) => VERIFIED.parse(reply)),
    base: refIn(flow.origin, `refs/heads/${BASE}`),
    mergeAttempt: state.mergeAttempt,
    hardenedTarget: state.hardenedTarget,
    hardened: state.hardened,
    integration: state.integration,
    codeMerged: state.codeMerged,
    unsupported: readWorld(flow.ghDir).unsupported,
  };
}

// Scripts the flow's issue; the Developer's draft adds a review-module
// submodule pinned at the base's first commit, whose gitlink the security
// bundle shows by path only. Returns that pin.
/** @param {Flow} flow */
function prepareReplayFlow(flow) {
  observeOps(flow);
  const gitlink = refIn(flow.origin, `refs/heads/${BASE}`);
  if (gitlink === null) {
    throw new Error("missing base head");
  }
  const draft = implementorTurn("hello, world", "Developer draft");
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    author: [authorTurn(GHERKIN, true)],
    implementor: [
      {
        ...draft,
        files: {
          ...draft.files,
          "repo/.gitmodules": `[submodule "review-module"]\n\tpath = review-module\n\turl = ${flow.origin}\n`,
        },
        gitlinks: { "review-module": gitlink },
      },
    ],
    reviewer: [
      implementorTurn("Hello, world", "Hardening fixes capitalization"),
      implementorTurn("Hello, world!", "Integration fixes CI"),
      hardeningTurn(),
      securityTurn(),
    ],
  });
  fs.writeFileSync(
    path.join(flow.root, "interrupt-finish"),
    "pause completion",
  );
  return gitlink;
}

// Synthetic migration fixture: retain the real confirmed merge and known
// original integration, but encode the pre-upgrade postmerge-Security shape.
// This is test data, never a runtime path for erasing candidate clearance.
/** @param {Flow} flow @param {import("../src/state.ts").Integration} integration */
function historicalMerge(flow, integration) {
  const state = savedState(readWorld(flow.ghDir));
  if (
    state.mergeAttempt.authorized.code !== integration.revision.code ||
    integration.reviewed.code === state.merged.code
  ) {
    throw new Error(
      "historical fixture needs the landed source and an earlier hardened revision",
    );
  }
  replaceState(flow, {
    ...state,
    stage: "merge",
    security: null,
    hardened: integration.reviewed,
    integration,
    mergeAttempt: {
      ...state.mergeAttempt,
      hardened: integration.reviewed,
      integration,
    },
  });
}

/** @param {Flow} flow @param {boolean} [withholdMergeBinding] */
function createReplayFlow(flow, withholdMergeBinding = false) {
  const originalConfig = fs.readFileSync(flow.config, "utf8");
  if (withholdMergeBinding) {
    const settings = z.looseObject({}).parse(JSON.parse(originalConfig));
    // CLOSED with no merge OID is incompatible with an FF own receipt,
    // regardless of host speed. The short window bounds only test duration.
    fs.writeFileSync(
      flow.config,
      JSON.stringify({
        ...settings,
        mergeConfirmation: { deadlineSeconds: 1, backoffSeconds: [1] },
      }),
    );
  }
  const gitlink = prepareReplayFlow(flow);
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
    world.withholdMergeBinding = withholdMergeBinding;
  });
  const integrated = runStage(flow, "merge");
  if (integrated.end !== "next") {
    throw new Error(`setup integration: ${JSON.stringify(integrated)}`);
  }
  const { integration } = savedState(readWorld(flow.ghDir));
  if (runStage(flow, "review").end !== "next") {
    throw new Error("fresh hardening did not complete");
  }
  let expected = "deferred";
  if (withholdMergeBinding) {
    expected = "stop";
  }
  const result = runStage(flow, "merge");
  if (result.end !== expected) {
    throw new Error(
      `setup merge: expected ${expected}, got ${JSON.stringify(result)}`,
    );
  }
  if (!withholdMergeBinding) {
    historicalMerge(flow, integration);
  }
  fs.unlinkSync(path.join(flow.root, "interrupt-finish"));
  const interruptedWorld = readWorld(flow.ghDir);
  fs.writeFileSync(flow.config, originalConfig);
  return { flow, interruptedWorld, gitlink };
}

export {
  createReplayFlow,
  expectedReplay,
  expectedTargetUpdates,
  historicalMerge,
  merges,
  prepareReplayFlow,
  replaceState,
  replayFacts,
  restoreReplay,
  securityBundle,
  securityEvidence,
  sessions,
};
