// One issue through the built orchestrator, jobs, ops and tool extensions.
// Local git origins, pipeline-flow-gh and pipeline-flow-pi fake the services;
// the stages themselves run unchanged, not through direct role calls.
import fs from "node:fs";
import path from "node:path";
import type { IssueState } from "../src/state.ts";
import { ISSUE_STATE } from "../src/state.ts";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.ts";
import type { FlowTurn, PiLogEntry } from "./fake-pipeline-flow-pi.ts";
import { piLog } from "./fake-pipeline-flow-pi.ts";
import { opsTrace } from "./pipeline-flow-ops-test-kit.ts";
import { jobLog, tick } from "./pipeline-flow-run-test-kit.ts";
import {
  authorTurn,
  implementorTurn,
  openFlowIssue,
  retainAuthoredIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { BASE, bareGit, refIn, scriptPi } from "./pipeline-flow-test-kit.ts";

// Returns each pi start, in order
function piStarts(flow: Flow): PiLogEntry[] {
  return piLog(flow.piDir).filter((entry) => entry.start === true);
}

function baseHead(flow: Flow): string {
  return String(refIn(flow.origin, `refs/heads/${BASE}`));
}

async function completeStage(
  flow: Flow,
  stages: string[],
  stage: string,
): Promise<{ started: string[]; log: string; state: IssueState }> {
  const result = await tick(flow);
  stages.push(...result.started);
  if (
    stage === "review" &&
    stages.filter((each) => each === "review").length === 1
  ) {
    const { hardened } = savedState(readWorld(flow.ghDir));
    if (hardened === null) {
      throw new Error("the first review saved no hardening");
    }
    withWorld(flow.ghDir, (world) => {
      world.failedHead = hardened.code;
    });
  }
  const checkpoint = savedState(readWorld(flow.ghDir));
  return { started: result.started, log: jobLog(flow), state: checkpoint };
}

function scriptFlow(flow: Flow, gherkin: string): void {
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

function state(flow: Flow): IssueState {
  return ISSUE_STATE.parse(savedState(readWorld(flow.ghDir)));
}

function historicalDirectReviewers(
  interrupted: FlowTurn,
  security: FlowTurn,
): FlowTurn[] {
  return [
    implementorTurn("Hello, world", "Hardening capitalizes the greeting"),
    implementorTurn("Hello, world!", "Hardening fixes CI"),
    securityTurn(),
    interrupted,
    security,
  ];
}

// The saved evidence a recovery must keep as it was.
type Evidence = Pick<
  IssueState,
  | "branch"
  | "pr"
  | "headSha"
  | "hardened"
  | "integration"
  | "merged"
  | "mergeAttempt"
  | "security"
  | "requirementsInputs"
  | "authorUsed"
  | "gherkin"
>;

// What a recovery left: the stopped state's stage, code and evidence, the
// origin's refs, whether the forbidden writer ran, the code ops it ran and
// the GitHub calls the fake didn't support.
interface RecoveryFacts {
  stage: string;
  stopCode: string | null;
  evidence: Evidence;
  codeMerged: IssueState["codeMerged"];
  refs: string;
  canary: boolean;
  codeOps: string[];
  unsupported: string[][];
}

const CODE_OPS = new Set(["start-pr", "open-pr", "merge", "push", "sync-base"]);

function starts(flow: Flow): PiLogEntry[] {
  return piLog(flow.piDir).filter((entry) => entry.start === true);
}

function evidence(saved: IssueState): Evidence {
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

function recoveryFacts(flow: Flow, traceStart: number): RecoveryFacts {
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

function expectedRecovery(original: IssueState, refs: string): RecoveryFacts {
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

export type { Evidence, RecoveryFacts };
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
