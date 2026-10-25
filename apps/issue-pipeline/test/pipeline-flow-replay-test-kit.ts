// An own-merge interruption fixture with real built jobs/ops and local fakes.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { MergeAttempt } from "../src/merge-provenance.ts";
import type { Integration, IssueState, Revision } from "../src/state.ts";
import { ghCalls } from "./fake-pipeline-flow-gh.ts";
import { nativeTargetUpdates } from "./fake-pipeline-flow-gh-native.ts";
import type { World } from "./fake-pipeline-flow-gh-world.ts";
import {
  readWorld,
  withWorld,
  writeWorld,
} from "./fake-pipeline-flow-gh-world.ts";
import type { PiLogEntry } from "./fake-pipeline-flow-pi.ts";
import { piLog } from "./fake-pipeline-flow-pi.ts";
import { observeOps, opsTrace } from "./pipeline-flow-ops-test-kit.ts";
import { confirmationsSince } from "./pipeline-flow-post-land-test-kit.ts";
import { runStage, runThroughTasks } from "./pipeline-flow-run-test-kit.ts";
import {
  authorTurn,
  implementorTurn,
  openFlowIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { BASE, ISSUE, refIn, scriptPi } from "./pipeline-flow-test-kit.ts";

const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    Then they see a polite greeting";
const SECURITY_TAG_LENGTH = 12;

// A target update a replay expects: the receipt's base, when it names one,
// moved to the authorized code.
interface ExpectedTargetUpdate {
  origin: string;
  ref: string;
  old: string | undefined;
  head: string | null;
}

// What a replay showed, or should show: the claim's and the saved
// codeMerged, the writer ops and merges it ran, the target's updates, the
// verifications and confirmations, the target's head, the saved evidence
// and the GitHub calls the fake didn't support.
interface ReplayFacts {
  claimCodeMerged: { pr: number | null; sha: string | null };
  forbidden: string[];
  merges: number;
  targetUpdates: ExpectedTargetUpdate[];
  verified: { pass: boolean; headSha: string }[];
  confirmations: { confirmed: boolean; headSha?: string | null | undefined }[];
  base: string | null;
  mergeAttempt: IssueState["mergeAttempt"];
  hardenedTarget: IssueState["hardenedTarget"];
  hardened: IssueState["hardened"];
  integration: IssueState["integration"];
  codeMerged: { pr: number | null; sha: string | null } | null;
  unsupported: string[][];
}

// The merge attempt `state` records.
function attemptOf(state: IssueState): MergeAttempt {
  const { mergeAttempt } = state;
  if (mergeAttempt === null) {
    throw new Error("the saved state records no merge attempt");
  }
  return mergeAttempt;
}

// The merged revision `state` records.
function mergedOf(state: IssueState): Revision {
  const { merged } = state;
  if (merged === null) {
    throw new Error("the saved state records no merged revision");
  }
  return merged;
}

function securityEvidence(
  flow: Flow,
  code: string,
): { launch: PiLogEntry | undefined; diff: string } {
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
function securityBundle(
  flow: Flow,
  mergedSha: string,
): { diff: string; bundle: string; files: string } {
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
function expectedTargetUpdates(world: World): ExpectedTargetUpdate[] {
  const mergeAttempt = attemptOf(savedState(world));
  return [
    {
      origin: world.origin,
      ref: `refs/heads/${mergeAttempt.target}`,
      old: mergeAttempt.operation?.base,
      head: mergeAttempt.authorized.code,
    },
  ];
}

//  No suite runs after Land; `confirmed`: read-only confirmation passed.
function expectedReplay(
  interruptedWorld: World,
  confirmed = true,
): ReplayFacts {
  const state = savedState(interruptedWorld);
  const merged = mergedOf(state);
  const codeMerged = { pr: state.pr, sha: merged.code };
  let confirmations: ReplayFacts["confirmations"] = [];
  if (confirmed) {
    confirmations = [{ confirmed: true, headSha: merged.code }];
  }
  return {
    claimCodeMerged: codeMerged,
    forbidden: [],
    merges: 0,
    targetUpdates: expectedTargetUpdates(interruptedWorld),
    verified: [],
    confirmations,
    base: merged.code,
    mergeAttempt: state.mergeAttempt,
    hardenedTarget: state.hardenedTarget,
    hardened: state.hardened,
    integration: state.integration,
    codeMerged,
    unsupported: [],
  };
}

function sessions(flow: Flow): number {
  return piLog(flow.piDir).filter((entry) => entry.start === true).length;
}

function merges(flow: Flow): string[][] {
  return ghCalls(flow.ghDir).filter(
    ([command, endpoint]) =>
      command === "api" && endpoint === "repos/o/r/merges",
  );
}

function replaceState(flow: Flow, state: object): void {
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

function restoreReplay(flow: Flow, world: World): void {
  writeWorld(flow.ghDir, structuredClone(world));
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, {
    reviewer: [{ output: {}, rejectPrompt: "read ECONNRESET" }],
  });
}

function replayFacts(flow: Flow, traceStart: number): ReplayFacts {
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
    confirmations: confirmationsSince(flow, traceStart),
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
function prepareReplayFlow(flow: Flow): string {
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
      implementorTurn("Hello, world!", "Hardening fixes CI"),
      securityTurn(),
    ],
  });
  fs.writeFileSync(
    path.join(flow.root, "interrupt-finish"),
    "pause completion",
  );
  return gitlink;
}

// Synthetic migration fixture: retain the real confirmed merge and a
// pre-activation integration receipt, but encode the pre-upgrade
// postmerge-Security shape. Since #186 no stage writes an integration
// receipt, so the setup builds it from the two real hardened revisions: the
// first one, whose CI failed, and the one Hardening fixed and Land took.
// This is test data, never a runtime path for erasing candidate clearance.
function historicalMerge(flow: Flow, integration: Integration): void {
  const state = savedState(readWorld(flow.ghDir));
  const mergeAttempt = attemptOf(state);
  const merged = mergedOf(state);
  if (
    mergeAttempt.authorized.code !== integration.revision.code ||
    integration.reviewed.code === merged.code
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
      ...mergeAttempt,
      hardened: integration.reviewed,
      integration,
    },
  });
}

function createReplayFlow(
  flow: Flow,
  withholdMergeBinding = false,
): { flow: Flow; interruptedWorld: World; gitlink: string } {
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
  const reviewed = savedState(readWorld(flow.ghDir)).hardened;
  if (reviewed === null) {
    throw new Error("setup review saved no hardening");
  }
  withWorld(flow.ghDir, (world) => {
    world.failedHead = reviewed.code;
    world.withholdMergeBinding = withholdMergeBinding;
  });
  const returned = runThroughTasks(flow, "merge").at(-1);
  if (returned?.end !== "next") {
    throw new Error(`setup CI return: ${JSON.stringify(returned)}`);
  }
  if (runStage(flow, "review").end !== "next") {
    throw new Error("fresh hardening did not complete");
  }
  const revision = savedState(readWorld(flow.ghDir)).hardened;
  if (revision === null) {
    throw new Error("fresh hardening saved no hardening");
  }
  const integration = { reviewed, revision };
  let expected = "deferred";
  if (withholdMergeBinding) {
    expected = "stop";
  }
  const result = runThroughTasks(flow, "merge").at(-1);
  if (result?.end !== expected) {
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

export type { ExpectedTargetUpdate, ReplayFacts };
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
