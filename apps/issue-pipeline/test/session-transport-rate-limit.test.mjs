// @ts-check
// A session that fails with a transport error (a connection reset or
// refusal, a timeout reading from the provider, ECONNRESET, ETIMEDOUT,
// EAI_AGAIN or a socket hang-up, alone or in a provider's `api_error`, in any
// letter case) defers its issue as a rate limit does (`rate-limit-defers`,
// #385), run through workflow-harness.mjs: released at its stage with no
// stop and the outcome `rate-limited`. A provider's other `api_error`s still
// stop, with the full error in the stop request.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONNECTION_RESET,
  issueRun,
  itemOf,
  opsOf,
  RATE_LIMIT_LINE,
  SERVER_ERROR,
  SOCKET_RESET,
} from "./rate-limit-test-kit.mjs";
import { releasedState, requestFor } from "./stage-outcome-test-kit.mjs";
import { claimAt, replyWith } from "./workflow-stages-fixtures.mjs";

const NO_FINDINGS = replyWith({ findings: [] });

// Issue #7 claimed at implement, as #369 was when its implementer failed.
const AT_IMPLEMENT = claimAt("implement", {
  plan: "Change src/a.ts and test it.",
  pr: 42,
  headSha: "aaaaaaa",
  implemented: false,
  spec: "## Behaviour\n\n1. src/a.ts does the thing.",
});

// The transport failures that defer, each named for its test.
/** @type {readonly (readonly [string, { ok: boolean, error: string }])[]} */
const TRANSPORT_FAILURES = [
  ["a connection reset in an api_error", CONNECTION_RESET],
  ["ECONNRESET", SOCKET_RESET],
];

for (const [name, failure] of TRANSPORT_FAILURES) {
  test(`an implementer that fails with ${name} leaves the issue at implement, rate-limited, with no stop`, async () => {
    const { trace, summary } = await issueRun(AT_IMPLEMENT, {
      "i7-implement": failure,
    });
    assert.equal(opsOf(trace).includes("stop"), false);
    const state = releasedState(trace);
    assert.deepEqual([state.stage, state.continuations], ["implement", {}]);
    assert.match(String(state.log?.at(-1)), RATE_LIMIT_LINE);
    assert.deepEqual(itemOf(summary), {
      stage: "implement",
      outcome: "rate-limited",
    });
  });
}

test("an implementer that fails with another api_error still stops, with the full error in the stop request", async () => {
  const { trace, summary } = await issueRun(AT_IMPLEMENT, {
    "i7-implement": SERVER_ERROR,
  });
  const { reason, detail } = requestFor(trace, "stop");
  assert.deepEqual(
    [reason, detail],
    ["the implementer session failed", SERVER_ERROR.error],
  );
  assert.notEqual(itemOf(summary).outcome, "rate-limited");
});

test("a reviewer whose socket hangs up leaves the issue at review, rate-limited, with no stop", async () => {
  const { trace, summary } = await issueRun(
    claimAt("review", { pr: 42, headSha: "bbbbbbb" }),
    {
      "i7-review-correctness": NO_FINDINGS,
      "i7-review-tests": { ok: false, error: "Error: socket hang up" },
      "i7-review-scope": NO_FINDINGS,
    },
    { "prepare-review": { ok: true, headSha: "bbbbbbb" } },
  );
  assert.equal(opsOf(trace).includes("stop"), false);
  assert.deepEqual(itemOf(summary), {
    stage: "review",
    outcome: "rate-limited",
  });
});

test("triage that times out reading from the provider is released at triage with no triage counted", async () => {
  const { trace, summary } = await issueRun(claimAt("triage"), {
    "i7-triage": { ok: false, error: "Timeout reading from the provider" },
  });
  assert.equal(opsOf(trace).includes("stop"), false);
  const state = releasedState(trace);
  assert.deepEqual([state.stage, state.triages], ["triage", 0]);
  assert.deepEqual(itemOf(summary), {
    stage: "triage",
    outcome: "rate-limited",
  });
});

test("a spec writer that fails with ETIMEDOUT defers without its retry", async () => {
  const { trace, summary } = await issueRun(
    claimAt("spec", {
      plan: "Change src/a.ts and test it.",
      pr: 42,
      headSha: "aaaaaaa",
      implemented: false,
    }),
    { "i7-spec": [{ ok: false, error: "connect ETIMEDOUT 1.2.3.4:443" }] },
  );
  assert.equal(opsOf(trace).includes("stop"), false);
  assert.equal(releasedState(trace).stage, "spec");
  assert.deepEqual(itemOf(summary), { stage: "spec", outcome: "rate-limited" });
});

test("a conflict resolver whose connection is refused aborts the rebase and leaves the issue at sync with no attempt counted", async () => {
  const { trace, summary } = await issueRun(
    claimAt("sync", { pr: 42, headSha: "bbbbbbb", reviewedSha: "bbbbbbb" }),
    {
      "i7-conflicts-1": {
        ok: false,
        error: "dial tcp 1.2.3.4:443: connect: Connection Refused",
      },
    },
    {
      "sync-base": {
        ok: true,
        conflict: true,
        inRebase: true,
        conflicts: ["src/a.ts"],
      },
      "finish-sync": { ok: true, resolved: false, reason: "aborted" },
    },
  );
  assert.equal(opsOf(trace).includes("stop"), false);
  const state = releasedState(trace);
  assert.deepEqual([state.stage, state.conflictFixes ?? 0], ["sync", 0]);
  assert.deepEqual(itemOf(summary), { stage: "sync", outcome: "rate-limited" });
});
