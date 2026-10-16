// @ts-check
// The built workflow's acceptance, security review and merge paths, run
// through workflow-harness.mjs. Each test pins the summary, the sessions that
// ran, and the ops requests and saved state the outcome goes through, read
// through stage-outcome-test-kit.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  releasedState,
  requestFor,
  sessionAgents,
} from "./stage-outcome-test-kit.mjs";
import {
  ACCEPTED,
  CHECKED,
  finishRun,
  issueSummary,
  SECURED,
} from "./workflow-finish-run-kit.mjs";
import { ISSUE, replyWith } from "./workflow-stages-fixtures.mjs";

const NO_STOP = /no stop request/u;
const PREPARED = { "prepare-review": { ok: true, headSha: "fffffff" } };

test("passing acceptance moves to security, held by the spawn cap", async () => {
  // security needs 3 spawns: 4 launched + 3 + a reserve of 4 passes 10.
  const { trace, summary } = await finishRun({
    stage: "accept",
    fields: CHECKED,
    ops: PREPARED,
    agents: {
      "i7-accept": replyWith({ verdict: "pass", reason: "Does what #7 asks." }),
    },
    config: { maxSpawnsPerRun: 11 },
  });
  assert.deepEqual(sessionAgents(trace), ["issue-pipeline-reader"]);
  const state = releasedState(trace);
  assert.deepEqual(
    [state.stage, state.acceptReason],
    ["security", "Does what #7 asks."],
  );
  assert.deepEqual(
    summary,
    issueSummary({ stage: "security", allocatedTokens: 880_000 }),
  );
});

test("failing acceptance sends the issue to fix", async () => {
  const { trace, summary } = await finishRun({
    stage: "accept",
    fields: CHECKED,
    ops: PREPARED,
    agents: {
      "i7-accept": replyWith({ verdict: "fail", reason: "Misses item 1." }),
    },
  });
  assert.deepEqual(sessionAgents(trace), ["issue-pipeline-reader"]);
  const state = releasedState(trace);
  assert.equal(state.stage, "fix");
  assert.deepEqual(
    state.findings.map(({ lenses, evidence, status }) => ({
      lenses,
      evidence,
      status,
    })),
    [{ lenses: ["acceptance"], evidence: "Misses item 1.", status: "open" }],
  );
  assert.throws(() => requestFor(trace, "stop"), NO_STOP);
  assert.deepEqual(
    summary,
    issueSummary({ stage: "fix", allocatedTokens: 880_000 }),
  );
});

test("a security review with no findings moves to merge, held by the spawn cap", async () => {
  // merge needs 2 spawns: 5 launched + 2 + a reserve of 4 passes 10.
  const { trace, summary } = await finishRun({
    stage: "security",
    fields: ACCEPTED,
    ops: PREPARED,
    agents: { "i7-security": replyWith({ findings: [] }) },
    config: { maxSpawnsPerRun: 11 },
  });
  assert.deepEqual(sessionAgents(trace), ["issue-pipeline-reader"]);
  assert.equal(releasedState(trace).stage, "merge");
  assert.deepEqual(
    summary,
    issueSummary({ stage: "merge", allocatedTokens: 940_000 }),
  );
});

test("a security finding sends the issue back to fix, held by the spawn cap", async () => {
  // fix needs 8 spawns: 5 launched + 8 + a reserve of 4 passes 16.
  const finding = {
    file: "src/a.ts",
    line: 9,
    title: "Logs the user's email",
    evidence: "console.log(user.email) on every request.",
    suggestion: "Drop the log line.",
    category: "user-harm",
  };
  const { trace, summary } = await finishRun({
    stage: "security",
    fields: ACCEPTED,
    ops: PREPARED,
    agents: { "i7-security": replyWith({ findings: [finding] }) },
    config: { maxSpawnsPerRun: 17 },
  });
  assert.deepEqual(sessionAgents(trace), ["issue-pipeline-reader"]);
  assert.equal(releasedState(trace).stage, "fix");
  assert.deepEqual(
    summary,
    issueSummary({ stage: "fix", allocatedTokens: 940_000 }),
  );
});

test("an issue at merge is merged", async () => {
  const { trace, summary } = await finishRun({
    stage: "merge",
    fields: SECURED,
    ops: { merge: { ok: true, merged: true } },
  });
  assert.deepEqual(sessionAgents(trace), []);
  const { number } = requestFor(trace, "merge");
  assert.equal(number, ISSUE);
  // The cleanup leaves the sweep's own issue alone.
  const { skip } = requestFor(trace, "cleanup");
  assert.equal(skip, ISSUE);
  assert.deepEqual(
    summary,
    issueSummary({
      stage: "merge",
      outcome: "merged",
      allocatedTokens: 940_000,
      rebaseAllocatedTokens: 0,
    }),
  );
});

test("a merge queued behind an older PR notes it and stays at merge", async () => {
  const { trace, summary } = await finishRun({
    stage: "merge",
    fields: SECURED,
    ops: {
      merge: {
        ok: true,
        merged: false,
        reason: "queued",
        waitingFor: 5,
        waitingForPr: 40,
      },
    },
  });
  const state = releasedState(trace);
  assert.equal(state.stage, "merge");
  assert.deepEqual(state.log, [
    "2026-10-15T12:00Z merge waits for #5 (older PR #40)",
  ]);
  assert.deepEqual(
    summary,
    issueSummary({ stage: "merge", allocatedTokens: 940_000 }),
  );
});
