// @ts-check
// The built workflow's acceptance, security review and merge paths, run
// through workflow-harness.mjs. Each test pins the launch keys and the summary
// by hand, and the whole trace in workflow-stages-finish.test.mjs.snapshot.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCEPTED,
  CHECKED,
  finishRun,
  issueSummary,
  SECURED,
} from "./workflow-finish-run-kit.mjs";
import { ISSUE, launchKeys, replyWith } from "./workflow-stages-fixtures.mjs";

/** @import { OpLaunch } from "../src/workflow/stages/types.ts" */
/** @import { IssueState } from "../src/workflow/types.ts" */

const PREPARED = { "prepare-review": { ok: true, headSha: "fffffff" } };

test("passing acceptance moves to security, held by the spawn cap", async ({
  assert: { snapshot },
}) => {
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
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-prep-3",
    "i7-accept-4",
    "i7-release-5",
    "cleanup-6",
  ]);
  assert.deepEqual(
    summary,
    issueSummary({ stage: "security", allocatedTokens: 880_000 }),
  );
  snapshot(trace);
});

test("failing acceptance stops the issue", async ({ assert: { snapshot } }) => {
  const { trace, summary } = await finishRun({
    stage: "accept",
    fields: CHECKED,
    ops: PREPARED,
    agents: {
      "i7-accept": replyWith({ verdict: "fail", reason: "Misses item 1." }),
    },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-prep-3",
    "i7-accept-4",
    "i7-stop-5",
    "cleanup-6",
  ]);
  assert.deepEqual(
    summary,
    issueSummary({
      stage: "accept",
      outcome: "stopped",
      reason: "the acceptance verifier found the issue is not fully resolved",
      allocatedTokens: 880_000,
      rebaseAllocatedTokens: 0,
    }),
  );
  snapshot(trace);
});

test("a security review with no findings moves to merge, held by the spawn cap", async ({
  assert: { snapshot },
}) => {
  // merge needs 2 spawns: 5 launched + 2 + a reserve of 4 passes 10.
  const { trace, summary } = await finishRun({
    stage: "security",
    fields: ACCEPTED,
    ops: PREPARED,
    agents: { "i7-security": replyWith({ findings: [] }) },
    config: { maxSpawnsPerRun: 11 },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-prep-3",
    "i7-security-4",
    "i7-save-5",
    "i7-release-6",
    "cleanup-7",
  ]);
  assert.deepEqual(
    summary,
    issueSummary({ stage: "merge", allocatedTokens: 940_000 }),
  );
  snapshot(trace);
});

test("a security finding sends the issue back to fix, held by the spawn cap", async ({
  assert: { snapshot },
}) => {
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
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-prep-3",
    "i7-security-4",
    "i7-save-5",
    "i7-release-6",
    "cleanup-7",
  ]);
  assert.deepEqual(
    summary,
    issueSummary({ stage: "fix", allocatedTokens: 940_000 }),
  );
  snapshot(trace);
});

test("an issue at merge is merged", async ({ assert: { snapshot } }) => {
  const { trace, summary } = await finishRun({
    stage: "merge",
    fields: SECURED,
    ops: { merge: { ok: true, merged: true } },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-merge-3",
    "cleanup-4",
  ]);
  // The cleanup leaves the sweep's own issue alone.
  const { skip } = /** @type {OpLaunch["payload"]} */ (
    trace.at(-1)?.request ?? {}
  );
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
  snapshot(trace);
});

test("a merge queued behind an older PR notes it and stays at merge", async ({
  assert: { snapshot },
}) => {
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
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-merge-3",
    "i7-release-4",
    "cleanup-5",
  ]);
  const { state } = /** @type {{ state: IssueState }} */ (
    trace.at(-2)?.request ?? {}
  );
  assert.deepEqual(state.log, [
    "2026-10-15T12:00Z merge waits for #5 (older PR #40)",
  ]);
  assert.deepEqual(
    summary,
    issueSummary({ stage: "merge", allocatedTokens: 940_000 }),
  );
  snapshot(trace);
});
