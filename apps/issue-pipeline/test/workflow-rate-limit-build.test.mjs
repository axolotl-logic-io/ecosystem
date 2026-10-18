// @ts-check
// A session of triage, implement, review or fix that fails on a model
// provider's rate limit or overload defers its issue the way a network error
// does (`rate-limit-defers`), run through workflow-harness.mjs: the issue is
// released at its stage with its work and the attempt counts it had as the
// stage began, with no stop, no further stage this sweep, and the outcome
// `rate-limited` in the summary. A session that fails otherwise still stops.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COOLING_DOWN,
  issueRun,
  itemOf,
  opsOf,
  RATE_LIMIT_LINE,
  TIMED_OUT,
} from "./rate-limit-test-kit.mjs";
import { releasedState, requestFor } from "./stage-outcome-test-kit.mjs";
import { claimAt, replyWith } from "./workflow-stages-fixtures.mjs";

const NO_FINDINGS = replyWith({ findings: [] });

// Issue #7 claimed at fix with one open finding from its review at bbbbbbb.
const AT_FIX = claimAt("fix", {
  pr: 42,
  headSha: "bbbbbbb",
  reviewedSha: "bbbbbbb",
  nextFindingId: 1,
  findings: [
    {
      id: "f1",
      file: "src/a.ts",
      line: 3,
      title: "Off by one",
      evidence: "The loop stops one item early.",
      suggestion: "Use <= in the loop bound.",
      lenses: ["correctness"],
      category: null,
      status: "open",
      disputed: false,
    },
  ],
});
test("a fixer that hits the rate limit leaves the issue at fix with its round uncounted and no stop", async () => {
  const { trace, summary } = await issueRun(AT_FIX, {
    "i7-fix-r1": COOLING_DOWN,
  });
  assert.equal(opsOf(trace).includes("stop"), false);
  const state = releasedState(trace);
  assert.deepEqual([state.stage, state.round], ["fix", 0]);
  assert.deepEqual(state.findings, AT_FIX.state.findings);
  assert.match(String(state.log?.at(-1)), RATE_LIMIT_LINE);
  assert.deepEqual(itemOf(summary), { stage: "fix", outcome: "rate-limited" });
});

test("a fixer that fails otherwise still stops the issue", async () => {
  const { trace } = await issueRun(AT_FIX, { "i7-fix-r1": TIMED_OUT });
  const { reason, detail } = requestFor(trace, "stop");
  assert.deepEqual(
    [reason, detail],
    ["the fixer session failed", "the session timed out"],
  );
});

test("a re-reviewer that hits the rate limit keeps the pushed fix and leaves the issue at fix", async () => {
  const { trace, summary } = await issueRun(
    AT_FIX,
    {
      "i7-fix-r1": replyWith({
        status: "done",
        fixed: ["f1"],
        disputed: [],
        summary: "Fixed the bound.",
      }),
      "i7-rereview-correctness-r1": COOLING_DOWN,
    },
    {
      push: { ok: true, headSha: "ccccccc" },
      "prepare-review": { ok: true, diffPath: "/runs/r1.diff" },
    },
  );
  assert.equal(opsOf(trace).includes("stop"), false);
  const state = releasedState(trace);
  assert.deepEqual(
    [state.stage, state.headSha, state.round],
    ["fix", "ccccccc", 0],
  );
  assert.deepEqual(itemOf(summary), { stage: "fix", outcome: "rate-limited" });
});

test("a reviewer that hits the rate limit leaves the issue at review with no stop", async () => {
  const { trace, summary } = await issueRun(
    claimAt("review", { pr: 42, headSha: "bbbbbbb" }),
    {
      "i7-review-correctness": NO_FINDINGS,
      "i7-review-tests": COOLING_DOWN,
      "i7-review-scope": NO_FINDINGS,
    },
    { "prepare-review": { ok: true, headSha: "bbbbbbb" } },
  );
  assert.equal(opsOf(trace).includes("stop"), false);
  assert.equal(releasedState(trace).reviewedSha ?? null, null);
  assert.deepEqual(itemOf(summary), {
    stage: "review",
    outcome: "rate-limited",
  });
});

test("an implementer that hits the rate limit leaves the issue at implement with no continuation counted", async () => {
  const { trace, summary } = await issueRun(
    claimAt("implement", {
      plan: "Change src/a.ts and test it.",
      pr: 42,
      headSha: "aaaaaaa",
      implemented: false,
      spec: "## Behaviour\n\n1. src/a.ts does the thing.",
    }),
    { "i7-implement": COOLING_DOWN },
  );
  assert.equal(opsOf(trace).includes("stop"), false);
  const state = releasedState(trace);
  assert.deepEqual([state.stage, state.continuations], ["implement", {}]);
  assert.deepEqual(itemOf(summary), {
    stage: "implement",
    outcome: "rate-limited",
  });
});

test("triage that hits the rate limit is released at triage with no triage counted", async () => {
  const { trace, summary } = await issueRun(claimAt("triage"), {
    "i7-triage": COOLING_DOWN,
  });
  assert.equal(opsOf(trace).includes("stop"), false);
  const state = releasedState(trace);
  assert.deepEqual([state.stage, state.triages], ["triage", 0]);
  assert.deepEqual(itemOf(summary), {
    stage: "triage",
    outcome: "rate-limited",
  });
});

test("a spec writer that hits the rate limit defers without its retry", async () => {
  const { trace, summary } = await issueRun(
    claimAt("spec", {
      plan: "Change src/a.ts and test it.",
      pr: 42,
      headSha: "aaaaaaa",
      implemented: false,
    }),
    { "i7-spec": [COOLING_DOWN] },
  );
  assert.equal(opsOf(trace).includes("stop"), false);
  assert.equal(releasedState(trace).stage, "spec");
  assert.deepEqual(itemOf(summary), { stage: "spec", outcome: "rate-limited" });
});
