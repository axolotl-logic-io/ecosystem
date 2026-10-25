// Revision-bound task results through the built ops (#183): every request is
// a fresh ops process against the stateful fake GitHub, and every claim is
// checked by what GitHub then shows. This file covers bindings, retries and
// budgets; task-results-authority.test.ts covers who may record and old data.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  binding,
  callMark,
  commentsOn,
  digest,
  dropRunFolders,
  recordAttempt,
  recordKindsOn,
  recordResult,
  runId,
  statusOf,
  statusRefusal,
  taskWorld,
  writesSince,
} from "./task-results-test-kit.ts";

const ISSUE = 7;
const OTHER_ISSUE = 8;
const BUDGET = 3;
const SHA_LENGTH = 40;
const OTHER_CODE = "a".repeat(SHA_LENGTH);
const SUMMARY = "checked R on T";
const PASSED_RERUN = /no attempt may start: the binding is passed/u;
const EXHAUSTED = /the binding is exhausted/u;
const UNKNOWN = /the binding is unknown/u;
const CONFLICTING = /conflicting verdicts/u;
const NO_ATTEMPT = /no attempt with its binding/u;
const NOT_LATEST = /does not follow the binding's latest attempt/u;
const REUSED = /reused its identity/u;

test("a fresh binding is missing, and reading it writes nothing", () => {
  const { flow, target } = taskWorld(ISSUE);
  const mark = callMark(flow.ghDir);
  const bound = binding({
    issue: ISSUE,
    task: "Integration",
    code: target,
    target,
  });
  assert.partialDeepStrictEqual(statusOf(flow, ISSUE, bound), {
    status: "missing",
    attempts: 0,
    budget: BUDGET,
  });
  assert.deepEqual(writesSince(flow.ghDir, mark), []);
});

test("a passed result is current only for its exact binding and never reruns", () => {
  const { flow, target } = taskWorld(ISSUE);
  const bound = binding({
    issue: ISSUE,
    task: "Integration",
    code: target,
    target,
  });
  const run = runId();
  const attempt = recordAttempt(flow, ISSUE, bound, {
    id: run,
    previous: null,
  });
  assert.partialDeepStrictEqual(attempt, {
    ok: true,
    attempt: 1,
    status: { status: "unknown", run },
  });
  const result = recordResult(flow, ISSUE, bound, {
    run,
    verdict: "passed",
    summary: SUMMARY,
  });
  assert.equal(result.status?.status, "passed");
  assert.deepEqual(recordKindsOn(flow.ghDir, ISSUE), ["attempt", "result"]);
  assert.deepEqual(
    commentsOn(flow.ghDir, ISSUE).map((item) => item.login),
    ["bot", "bot"],
    "only the landing account records",
  );

  const mark = callMark(flow.ghDir);
  const again = recordAttempt(flow, ISSUE, bound, {
    id: runId(),
    previous: run,
  });
  assert.equal(again.ok, false);
  assert.match(String(again.error), PASSED_RERUN);
  assert.deepEqual(writesSince(flow.ghDir, mark), []);

  // Every part of the binding counts: a changed part is not the passed binding.
  const variants = [
    { ...bound, task: "Security" },
    { ...bound, revision: { ...bound.revision, code: OTHER_CODE } },
    { ...bound, revision: { ...bound.revision, inputs: digest("new inputs") } },
    { ...bound, revision: { ...bound.revision, policy: digest("new policy") } },
    { ...bound, target: { ...bound.target, commit: OTHER_CODE } },
  ];
  for (const variant of variants) {
    assert.equal(
      statusOf(flow, ISSUE, variant).status,
      "missing",
      JSON.stringify(variant),
    );
  }
  // An absent, malformed or foreign part never matches: the read is refused.
  const { policy: _policy, ...noPolicy } = bound.revision;
  for (const malformed of [
    { ...bound, revision: noPolicy },
    { ...bound, revision: { ...bound.revision, code: "abc123" } },
    { ...bound, target: { ...bound.target, branch: "main" } },
    { ...bound, workItem: OTHER_ISSUE },
    { ...bound, repo: "o/other" },
  ]) {
    assert.equal(
      statusRefusal(flow, ISSUE, malformed).ok,
      false,
      JSON.stringify(malformed),
    );
  }
});

test("retries take new linked runs, and the budget survives restarts and new run folders", () => {
  const { flow, target } = taskWorld(ISSUE);
  const bound = binding({ issue: ISSUE, task: "Sync", code: target, target });
  const runs: string[] = [];
  for (let attempt = 1; attempt <= BUDGET; attempt += 1) {
    const run = runId();
    const started = recordAttempt(flow, ISSUE, bound, {
      id: run,
      previous: runs.at(-1) ?? null,
    });
    assert.partialDeepStrictEqual(started, { ok: true, attempt });
    recordResult(flow, ISSUE, bound, {
      run,
      verdict: "failed",
      summary: `attempt ${attempt} conflicted`,
    });
    runs.push(run);
    // Nothing local carries the count: each op is a new process, and the
    // run folders go too.
    dropRunFolders(flow);
  }
  assert.partialDeepStrictEqual(statusOf(flow, ISSUE, bound), {
    status: "exhausted",
    attempts: BUDGET,
  });
  const mark = callMark(flow.ghDir);
  const refused = recordAttempt(flow, ISSUE, bound, {
    id: runId(),
    previous: runs.at(-1) ?? null,
  });
  assert.match(String(refused.error), EXHAUSTED);
  assert.deepEqual(writesSince(flow.ghDir, mark), []);

  // A new target commit is a new binding with a new budget. Its first run
  // may link to the run before it; later runs must follow the latest, and no
  // run reuses an identity.
  const moved = { ...bound, target: { ...bound.target, commit: OTHER_CODE } };
  const first = runId();
  assert.partialDeepStrictEqual(
    recordAttempt(flow, ISSUE, moved, {
      id: first,
      previous: runs.at(-1) ?? null,
    }),
    { ok: true, attempt: 1 },
  );
  recordResult(flow, ISSUE, moved, {
    run: first,
    verdict: "failed",
    summary: "conflicted",
  });
  const unlinked = recordAttempt(flow, ISSUE, moved, {
    id: runId(),
    previous: runs[0] ?? null,
  });
  assert.match(String(unlinked.error), NOT_LATEST);
  const reused = recordAttempt(flow, ISSUE, moved, {
    id: first,
    previous: first,
  });
  assert.match(String(reused.error), REUSED);
  assert.equal(
    writesSince(flow.ghDir, mark).length,
    2,
    "only the moved binding's attempt and result",
  );
});

test("an unsettled or unknown attempt is never repeated; only read-only reconciliation settles it", () => {
  const { flow, target } = taskWorld(ISSUE);
  const bound = binding({ issue: ISSUE, task: "Land", code: target, target });
  const run = runId();
  recordAttempt(flow, ISSUE, bound, { id: run, previous: null });
  assert.partialDeepStrictEqual(statusOf(flow, ISSUE, bound), {
    status: "unknown",
    run,
  });
  recordResult(flow, ISSUE, bound, {
    run,
    verdict: "unknown",
    summary: "the fast-forward response was lost",
  });
  const mark = callMark(flow.ghDir);
  const retry = recordAttempt(flow, ISSUE, bound, {
    id: runId(),
    previous: run,
  });
  assert.match(String(retry.error), UNKNOWN);
  assert.deepEqual(writesSince(flow.ghDir, mark), []);

  const settled = recordResult(flow, ISSUE, bound, {
    run,
    verdict: "passed",
    summary: "the target reads as the exact candidate",
  });
  assert.equal(settled.status?.status, "passed");
  const conflicting = recordResult(flow, ISSUE, bound, {
    run,
    verdict: "failed",
    summary: SUMMARY,
  });
  assert.match(String(conflicting.error), CONFLICTING);
  const orphan = recordResult(flow, ISSUE, bound, {
    run: runId(),
    verdict: "passed",
    summary: SUMMARY,
  });
  assert.match(String(orphan.error), NO_ATTEMPT);
});
