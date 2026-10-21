// @ts-check
// An own-merge interruption fixture with real built jobs/ops and local fakes.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ghCalls } from "./pipeline-flow-gh.mjs";
import { nativeTargetUpdates } from "./pipeline-flow-gh-native.mjs";
import { readWorld, withWorld } from "./pipeline-flow-gh-world.mjs";
import { BASE, ISSUE, refIn, scriptPi } from "./pipeline-flow-kit.mjs";
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
const STATE_BLOCK = /<!-- agent-pipeline:state\n[\s\S]*?\n-->/u;
const NO_WRITER_OPS = ["merge", "push", "sync-base", "ready-pr", "exit-push"];
const VERIFIED = z.object({ pass: z.boolean(), headSha: z.string() });
const CLAIM = z.object({
  state: z.object({
    codeMerged: z.object({ pr: z.number(), sha: z.string() }),
  }),
});
/** @param {import("./pipeline-flow-gh-world.mjs").World} world */
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

/** @param {import("./pipeline-flow-gh-world.mjs").World} interruptedWorld @param {boolean} [checked] */
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
      INTERRUPTED,
    ],
  });
  return gitlink;
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
  for (const expected of ["wait", "deferred"]) {
    let end = expected;
    if (withholdMergeBinding && expected === "deferred") {
      end = "stop";
    }
    const result = runStage(flow, "merge");
    if (result.end !== end) {
      throw new Error(
        `setup merge: expected ${end}, got ${JSON.stringify(result)}`,
      );
    }
  }
  const interruptedWorld = readWorld(flow.ghDir);
  fs.writeFileSync(flow.config, originalConfig);
  return { flow, interruptedWorld, gitlink };
}

export {
  createReplayFlow,
  expectedReplay,
  expectedTargetUpdates,
  merges,
  prepareReplayFlow,
  replaceState,
  replayFacts,
  securityEvidence,
  sessions,
};
