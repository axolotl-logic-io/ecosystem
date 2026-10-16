// @ts-check
// The built workflow's security and acceptance stops, run through
// workflow-harness.mjs: a stop for an open security finding carries the
// finding's harm as its code, and one for a failed acceptance check's finding
// carries "acceptance" (#266).
// Each test pins the sessions that ran, the stop request's code and the
// summary by hand, with no snapshot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { STOP_PREFIX } from "../src/stops.ts";
import { requestFor, sessionAgents } from "./stage-outcome-test-kit.mjs";
import { runWorkflow } from "./workflow-harness.mjs";
import {
  claimAt,
  ISSUE,
  ROUTINE_OPS,
  replyWith,
  sweepReply,
  sweepSummary,
  WORKFLOW_ARGS,
} from "./workflow-stages-fixtures.mjs";

/** @import { Scripted } from "./workflow-harness.mjs" */

// Issue #7 with acceptance passed at fffffff.
const ACCEPTED = {
  pr: 42,
  headSha: "fffffff",
  reviewedSha: "fffffff",
  verifiedSha: "fffffff",
  verifySummary: "test: passed",
  implemented: true,
  spec: "## Behaviour\n\n1. src/a.ts does the thing.",
  acceptReason: "Does what #7 asks.",
};
// A security reviewer's finding that harms the users.
const LEAK = {
  file: "src/a.ts",
  line: 9,
  title: "Logs the user's email",
  evidence: "console.log(user.email) on every request.",
  suggestion: "Drop the log line.",
  category: "user-harm",
};

// A run of issue #7 claimed at `stage` with `fields`, with ops and agents.
/**
 * @param {object} run
 * @param {string} run.stage
 * @param {object} run.fields
 * @param {Record<string, Scripted>} [run.ops]
 * @param {Record<string, Scripted>} [run.agents]
 * @returns {ReturnType<typeof runWorkflow>}
 */
function codesRun({ stage, fields, ops = {}, agents = {} }) {
  return runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: claimAt(stage, fields),
      ...ops,
    },
    agents,
  });
}

// The summary of issue #7 stopped at `stage` by LEAK past its fix rounds.
/** @param {string} stage @returns {object} */
function leakStopped(stage) {
  return sweepSummary({
    items: [
      {
        issue: 7,
        pr: 42,
        stage,
        outcome: "stopped",
        reason:
          "security review (user-harm): Logs the user's email is still open after 2 fix rounds",
      },
    ],
  });
}

test("a security finding past the fix rounds stops with its harm as the code", async () => {
  const { trace, summary } = await codesRun({
    stage: "security",
    fields: { ...ACCEPTED, securityRounds: 2 },
    ops: { "prepare-review": { ok: true, headSha: "fffffff" } },
    agents: { "i7-security": replyWith({ findings: [LEAK] }) },
  });
  assert.deepEqual(sessionAgents(trace), ["issue-pipeline-reader"]);
  const { code } = requestFor(trace, "stop");
  assert.equal(code, "user-harm");
  assert.deepEqual(summary, leakStopped("security"));
});

test("an open security finding stops the merge with its harm as the code", async () => {
  const open = { ...LEAK, id: "f1", lenses: ["security"], status: "open" };
  const { trace, summary } = await codesRun({
    stage: "merge",
    fields: {
      ...ACCEPTED,
      findings: [{ ...open, disputed: false }],
    },
  });
  assert.deepEqual(sessionAgents(trace), []);
  const { code } = requestFor(trace, "stop");
  assert.equal(code, "user-harm");
  assert.deepEqual(summary, leakStopped("merge"));
});

const NOT_RESOLVED = /not fully resolved/u;
const FIXER_DISPUTE = /Fixer's dispute: The issue never asks for it\./u;
const NO_PUSH = /no push request/u;
// The open finding a failed acceptance check left on issue #7.
const UNMET = {
  id: "f1",
  file: "",
  line: 0,
  title: "acceptance: issue not fully resolved",
  evidence: "The wiki misses the new stage.",
  suggestion: "Meet the requirement.",
  lenses: ["acceptance"],
  category: null,
  status: "open",
  disputed: false,
};
// Issue #7 sent back to fix by a failed acceptance check.
const AT_FIX = {
  ...ACCEPTED,
  acceptReason: undefined,
  findings: [UNMET],
  nextFindingId: 1,
};

test("an acceptance finding past the fix rounds stops with the acceptance code", async () => {
  const { trace } = await codesRun({
    stage: "fix",
    fields: { ...AT_FIX, round: 2 },
  });
  assert.deepEqual(sessionAgents(trace), []);
  const { code, reason, detail } = requestFor(trace, "stop");
  assert.equal(code, "acceptance");
  assert.match(String(reason), NOT_RESOLVED);
  assert.equal(`${STOP_PREFIX}${String(code)}`, "agent:stopped-acceptance");
  assert.ok(String(detail).includes(UNMET.evidence));
});

test("a fixer's dispute of the acceptance finding stops before the push", async () => {
  const { trace } = await codesRun({
    stage: "fix",
    fields: { ...AT_FIX, round: 0 },
    agents: {
      "i7-fix-r1": replyWith({
        status: "done",
        fixed: [],
        disputed: [{ id: "f1", evidence: "The issue never asks for it." }],
        summary: "Disputed f1.",
      }),
    },
  });
  const { code, reason, detail, comments } = requestFor(trace, "stop");
  assert.equal(code, "acceptance");
  assert.match(String(reason), NOT_RESOLVED);
  assert.ok(String(detail).includes(UNMET.evidence));
  assert.match(String(detail), FIXER_DISPUTE);
  assert.ok(JSON.stringify(comments).includes("fixer (round 1)"));
  // Only the fixer ran: no re-review session, and nothing was pushed.
  assert.equal(sessionAgents(trace).length, 1);
  assert.throws(() => requestFor(trace, "push"), NO_PUSH);
});
