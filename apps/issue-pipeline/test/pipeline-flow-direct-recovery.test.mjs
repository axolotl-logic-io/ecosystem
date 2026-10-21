// @ts-check
// Real built jobs and local Git; only GitHub and Pi are synthetic services.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { mergeAuthorization } from "../src/state.ts";
import { humanComment } from "./fake-pipeline-flow-gh.mjs";
import { withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { observeOps, opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import {
  expectedRecovery,
  historicalDirectReviewers,
  recoveryFacts,
  starts,
  state,
} from "./pipeline-flow-provenance-test-kit.mjs";
import {
  historicalMerge,
  replaceState,
} from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run-test-kit.mjs";
import {
  hardeningTurn,
  implementorTurn,
  openFlowIssue,
  securityTurn,
} from "./pipeline-flow-script-test-kit.mjs";
import {
  BASE,
  bareGit,
  ISSUE,
  SLUG,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.mjs";

/** @typedef {import('./pipeline-flow-test-kit.mjs').Flow} Flow */
const CHANGED = "Also greet departing visitors.";
const INTERRUPTED = { output: {}, rejectPrompt: "read ECONNRESET" };
const RECONCILE = /explicit reconciliation/u;
/** @type {Flow[]} */
const flows = [];
after(() => {
  for (const flow of flows) {
    stopJobs(flow);
  }
});

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
  /** @type {import('./fake-pipeline-flow-pi.mjs').FlowTurn} */
  const security = securityTurn();
  if (changeDuringSecurity) {
    security.humanComment = {
      dir: flow.ghDir,
      issue: ISSUE,
      login: "alice",
      body: CHANGED,
    };
  }
  /** @type {import('./fake-pipeline-flow-pi.mjs').FlowTurn[]} */
  const reviewers = [hardeningTurn(), security];
  if (changeDuringSecurity) {
    reviewers.splice(
      0,
      reviewers.length,
      ...historicalDirectReviewers(INTERRUPTED, security),
    );
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

/** @type {Flow | undefined} */
let historicalFlow;
/** @type {{ flow: Flow, original: import("../src/state.ts").IssueState, refs: string, traceStart: number, stopped: import("../src/state.ts").IssueState } | undefined} */
let recovery;

test("direct historical recovery starts with candidate clearance and a confirmed own FF after changed integration", () => {
  const { flow, setup } = directFlow(true);
  assert.deepEqual(setup, ["next", "next"]);
  const earlier = state(flow).hardened;
  assert.ok(earlier);
  withWorld(flow.ghDir, (world) => {
    world.failedHead = earlier.code;
  });
  assert.equal(runStage(flow, "merge").end, "next");
  const { integration } = state(flow);
  assert.ok(integration);
  assert.notEqual(integration.reviewed.code, integration.revision.code);
  assert.equal(runStage(flow, "review").end, "next");
  const marker = path.join(flow.root, "interrupt-finish");
  fs.writeFileSync(marker, "pause at confirmed candidate result\n");
  assert.equal(runStage(flow, "merge").end, "deferred");
  fs.unlinkSync(marker);
  const candidate = state(flow);
  assert.ok(candidate.merged?.code);
  assert.equal(candidate.security?.phase, "candidate");
  assert.deepEqual(
    candidate.security?.revision,
    candidate.mergeAttempt?.authorized,
  );
  assert.equal(candidate.merged.code, candidate.security?.revision.code);
  assert.notEqual(integration.reviewed.code, candidate.merged.code);
  assert.equal(candidate.authorUsed, false);
  assert.equal(candidate.gherkin, null);
  assert.ok(candidate.requirementsInputs);
  assert.equal(
    starts(flow).some(({ role }) => role === "author"),
    false,
  );
  historicalMerge(flow, integration);
  const historical = state(flow);
  assert.equal(historical.stage, "merge");
  assert.equal(historical.security, null);
  assert.deepEqual(historical.hardened, integration.reviewed);
  assert.deepEqual(historical.integration, integration);
  historicalFlow = flow;
});

test("trusted inputs changing inside direct postmerge Security stop before a later Developer can receive writer tools", () => {
  assert.ok(historicalFlow);
  const flow = historicalFlow;
  const beforeInterruption = starts(flow).length;
  assert.equal(runStage(flow, "merge").end, "deferred");
  const interrupted = starts(flow).slice(beforeInterruption);
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.role, "reviewer");
  assert.equal(interrupted[0]?.commitScope, false);
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
  const stopped = structuredClone(state(flow));
  assert.match(stopped.log.join("\n"), RECONCILE);
  recovery = { flow, original, refs, traceStart, stopped };
});

test("a stale Developer request after direct historical reconciliation starts no writer and preserves provenance", () => {
  assert.ok(recovery);
  const { flow, original, refs, traceStart, stopped } = recovery;
  // Nonzero fixture counters make the canonical reset observable.
  replaceState(flow, {
    ...stopped,
    review: { ...stopped.review, round: 1 },
    counts: { conflictFixes: 1, syncs: 1 },
  });
  const sessions = starts(flow).length;
  const mismatch = runStage(flow, "implement");
  assert.deepEqual(mismatch, {
    issue: ISSUE,
    stage: "implement",
    end: "unclaimed",
    reason: "the issue is at merge, not implement",
  });
  assert.equal(starts(flow).length, sessions);
  assert.deepEqual(recoveryFacts(flow, traceStart), {
    ...expectedRecovery(original, refs),
    stage: "merge",
    stopCode: null,
  });
  const resumed = state(flow);
  assert.equal(resumed.stoppedStage, null);
  assert.deepEqual(resumed.log, stopped.log);
  assert.deepEqual(resumed.review, { ...stopped.review, round: 0 });
  assert.deepEqual(resumed.counts, { conflictFixes: 0, syncs: 0 });
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
