// @ts-check
// Real built jobs and local Git; only GitHub and Pi are synthetic services.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { ISSUE_STATE, mergeAuthorization } from "../src/state.ts";
import { humanComment } from "./pipeline-flow-gh.mjs";
import { readWorld } from "./pipeline-flow-gh-world.mjs";
import {
  BASE,
  bareGit,
  ISSUE,
  SLUG,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-kit.mjs";
import { observeOps, opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { piLog } from "./pipeline-flow-pi.mjs";
import { replaceState } from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run.mjs";
import {
  hardeningTurn,
  implementorTurn,
  openFlowIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script.mjs";

/** @typedef {import('./pipeline-flow-kit.mjs').Flow} Flow */
/** @typedef {import('../src/state.ts').IssueState} IssueState */
const CHANGED = "Also greet departing visitors.";
const INTERRUPTED = { output: {}, rejectPrompt: "read ECONNRESET" };
const RECONCILE = /explicit reconciliation/u;
const CODE_OPS = new Set(["start-pr", "open-pr", "merge", "push", "sync-base"]);
/** @type {Flow[]} */
const flows = [];
after(() => {
  for (const flow of flows) {
    stopJobs(flow);
  }
});

/** @param {Flow} flow */
function state(flow) {
  return ISSUE_STATE.parse(savedState(readWorld(flow.ghDir)));
}

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

/** @param {boolean} [changeDuringSecurity] */
function directFlow(changeDuringSecurity = false) {
  const flow = setUpFlow();
  flows.push(flow);
  observeOps(flow);
  // A non-default target keeps the genuine merged issue open for recovery.
  const base = bareGit(flow.origin, ["rev-parse", BASE]);
  bareGit(flow.origin, ["update-ref", "refs/heads/main", base]);
  bareGit(flow.origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  const job = path.join(
    flow.root,
    "work",
    SLUG,
    "jobs",
    `issue-${ISSUE}-implement`,
  );
  const canary = path.relative(
    job,
    path.join(flow.tmp, "forbidden-direct-writer"),
  );
  /** @type {import('./pipeline-flow-pi.mjs').FlowTurn} */
  const security = securityTurn();
  if (changeDuringSecurity) {
    security.humanComment = {
      dir: flow.ghDir,
      issue: ISSUE,
      login: "alice",
      body: CHANGED,
    };
  }
  /** @type {import('./pipeline-flow-pi.mjs').FlowTurn[]} */
  const reviewers = [hardeningTurn(), security];
  if (changeDuringSecurity) {
    reviewers.splice(1, 0, INTERRUPTED);
  }
  scriptPi(flow, {
    implementor: [
      implementorTurn("Hello, world!", "Greet visitors"),
      {
        files: { [canary]: "unauthorized local write\n" },
        output: { outcome: "done", summary: "Must not run" },
      },
    ],
    reviewer: reviewers,
  });
  const setup = ["implement", "review"].map(
    (stage) => runStage(flow, stage).end,
  );
  return { flow, setup };
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

test("trusted inputs changing inside direct postmerge Security stop before a later Developer can receive writer tools", () => {
  const { flow, setup } = directFlow(true);
  assert.deepEqual(setup, ["next", "next"]);
  assert.equal(runStage(flow, "merge").end, "deferred");
  const original = state(flow);
  assert.ok(original.merged?.code);
  assert.ok(original.mergeAttempt);
  const refs = bareGit(flow.origin, ["show-ref"]);
  const traceStart = opsTrace(flow).length;
  const before = starts(flow).length;
  const result = runStage(flow, "merge");
  assert.equal(result.end, "stop");
  assert.match(JSON.stringify(result), RECONCILE);
  assert.deepEqual(
    recoveryFacts(flow, traceStart),
    expectedRecovery(original, refs),
  );
  const fresh = starts(flow).slice(before);
  assert.equal(fresh.length, 1);
  const [security] = fresh;
  assert.equal(security?.role, "reviewer");
  const args = security?.argv ?? [];
  const tools = String(args[args.indexOf("--tools") + 1]).split(",");
  assert.ok(tools.includes("structured_output"));
  for (const tool of ["bash", "edit", "write", "pipeline_commit"]) {
    assert.equal(tools.includes(tool), false);
  }
  assert.equal(security?.extensions.includes("pipeline-commit.mjs"), false);
  const sessions = starts(flow).length;
  assert.equal(runStage(flow, "implement").end, "unclaimed");
  assert.equal(starts(flow).length, sessions);
  assert.deepEqual(
    recoveryFacts(flow, traceStart),
    expectedRecovery(original, refs),
  );
});

for (const staleImplement of [false, true]) {
  test(`changed direct completion replay cannot launch a writer, stale implement=${staleImplement}`, () => {
    const { flow, setup } = directFlow();
    assert.deepEqual(setup, ["next", "next"]);
    const marker = path.join(flow.root, "interrupt-finish");
    fs.writeFileSync(marker, "interrupt completion\n");
    assert.equal(runStage(flow, "merge").end, "deferred");
    fs.unlinkSync(marker);
    const original = state(flow);
    assert.equal(original.stage, "done");
    assert.ok(original.security);
    assert.ok(original.mergeAttempt);
    if (staleImplement) {
      replaceState(flow, {
        ...original,
        stage: "stopped",
        stoppedStage: "implement",
        stopCode: "error",
      });
    }
    humanComment(flow.ghDir, ISSUE, "alice", CHANGED);
    const refs = bareGit(flow.origin, ["show-ref"]);
    const traceStart = opsTrace(flow).length;
    const before = starts(flow).length;
    let stage = "merge";
    if (staleImplement) {
      stage = "implement";
    }
    const result = runStage(flow, stage);
    assert.equal(result.end, "stop");
    assert.match(JSON.stringify(result), RECONCILE);
    assert.equal(starts(flow).length, before);
    assert.deepEqual(
      recoveryFacts(flow, traceStart),
      expectedRecovery(original, refs),
    );
  });
}

test("resumed stale direct implement with an armed merge attempt cannot start Pi or mutate code even before merge is confirmed", () => {
  const { flow, setup } = directFlow();
  assert.deepEqual(setup, ["next", "next"]);
  const retained = state(flow);
  const authorized = mergeAuthorization(retained);
  assert.ok(authorized);
  assert.ok(retained.pr);
  assert.ok(retained.branch);
  assert.ok(retained.hardened);
  const original = {
    ...retained,
    stage: /** @type {const} */ ("stopped"),
    stoppedStage: /** @type {const} */ ("implement"),
    stopCode: "error",
    mergeAttempt: {
      repo: "o/r",
      pr: retained.pr,
      target: BASE,
      branch: retained.branch,
      authorized,
      hardened: retained.hardened,
      integration: retained.integration,
      result: null,
      reads: 0,
    },
  };
  replaceState(flow, original);
  const refs = bareGit(flow.origin, ["show-ref"]);
  const traceStart = opsTrace(flow).length;
  const before = starts(flow).length;
  assert.equal(runStage(flow, "implement").end, "stop");
  assert.equal(starts(flow).length, before);
  assert.deepEqual(
    recoveryFacts(flow, traceStart),
    expectedRecovery(original, refs),
  );
});
