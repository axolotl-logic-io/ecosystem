// Real built jobs and local Git; only GitHub and Pi are synthetic services.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import type { IssueState } from "../src/state.ts";
import { mergeAuthorization } from "../src/state.ts";
import { humanComment } from "./fake-pipeline-flow-gh.ts";
import { withWorld } from "./fake-pipeline-flow-gh-world.ts";
import type { FlowTurn } from "./fake-pipeline-flow-pi.ts";
import { observeOps, opsTrace } from "./pipeline-flow-ops-test-kit.ts";
import {
  expectedRecovery,
  historicalDirectReviewers,
  recoveryFacts,
  starts,
  state,
} from "./pipeline-flow-provenance-test-kit.ts";
import {
  historicalMerge,
  replaceState,
} from "./pipeline-flow-replay-test-kit.ts";
import {
  runStage,
  runThroughTasks,
  stopJobs,
} from "./pipeline-flow-run-test-kit.ts";
import {
  hardeningTurn,
  implementorTurn,
  openFlowIssue,
  securityTurn,
} from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import {
  BASE,
  bareGit,
  ISSUE,
  SLUG,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.ts";

const CHANGED = "Also greet departing visitors.";
const INTERRUPTED = { output: {}, rejectPrompt: "read ECONNRESET" };
const RECONCILE = /explicit reconciliation/u;
const READ_ONLY_RECONCILIATION = /read-only reconciliation is required/u;
const AFTER_LAND_OPS = ["verify", "prepare-review", "finish"];
const flows: Flow[] = [];
after(() => {
  for (const flow of flows) {
    stopJobs(flow);
  }
});

function directFlow(changeDuringSecurity = false): {
  flow: Flow;
  setup: string[];
} {
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
  const security: FlowTurn = securityTurn();
  if (changeDuringSecurity) {
    security.humanComment = {
      dir: flow.ghDir,
      issue: ISSUE,
      login: "alice",
      body: CHANGED,
    };
  }
  const reviewers: FlowTurn[] = [hardeningTurn(), security];
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

let historicalFlow: Flow | undefined;
let recovery:
  | {
      flow: Flow;
      original: IssueState;
      refs: string;
      traceStart: number;
      stopped: IssueState;
    }
  | undefined;

test("direct historical recovery starts with candidate clearance and a confirmed own FF after changed integration", () => {
  const { flow, setup } = directFlow(true);
  assert.deepEqual(setup, ["next", "next"]);
  const earlier = state(flow).hardened;
  assert.ok(earlier);
  withWorld(flow.ghDir, (world) => {
    world.failedHead = earlier.code;
  });
  // Merge relays its Integration, then CI fails on the first head, and
  // Hardening fixes it. The fixture's pre-upgrade integration receipt is
  // built from those two real revisions.
  assert.equal(runThroughTasks(flow, "merge").at(-1)?.end, "next");
  assert.equal(runStage(flow, "review").end, "next");
  const fixed = state(flow).hardened;
  assert.ok(fixed);
  const integration = { reviewed: earlier, revision: fixed };
  assert.notEqual(integration.reviewed.code, integration.revision.code);
  const marker = path.join(flow.root, "interrupt-finish");
  fs.writeFileSync(marker, "pause at confirmed candidate result\n");
  assert.equal(runThroughTasks(flow, "merge").at(-1)?.end, "deferred");
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

// No postmerge Security session runs after Land (#185), so trusted inputs
// cannot change inside one: the historical merge stops read-only at once.
test("a direct historical merge stops read-only with no postmerge suite or Security session, before a later Developer can receive writer tools", () => {
  assert.ok(historicalFlow);
  const flow = historicalFlow;
  const original = state(flow);
  assert.ok(original.merged?.code);
  assert.ok(original.mergeAttempt);
  const refs = bareGit(flow.origin, ["show-ref"]);
  const traceStart = opsTrace(flow).length;
  const before = starts(flow).length;
  const result = runStage(flow, "merge");
  assert.equal(result.end, "stop");
  assert.match(JSON.stringify(result), READ_ONLY_RECONCILIATION);
  assert.deepEqual(
    recoveryFacts(flow, traceStart),
    expectedRecovery(original, refs),
  );
  assert.equal(starts(flow).length, before);
  const ops = opsTrace(flow)
    .slice(traceStart)
    .map(({ request }) => request.op);
  for (const op of AFTER_LAND_OPS) {
    assert.equal(ops.includes(op), false, op);
  }
  const stopped = structuredClone(state(flow));
  assert.match(stopped.log.join("\n"), READ_ONLY_RECONCILIATION);
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
    assert.equal(runThroughTasks(flow, "merge").at(-1)?.end, "deferred");
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
    stage: "stopped" as const,
    stoppedStage: "implement" as const,
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
