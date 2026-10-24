// @ts-check
// Revision-bound task results through the built ops (#183): every request is
// a fresh ops process against the stateful fake GitHub, and every claim is
// checked by what GitHub then shows. The ops are inactive: no role calls them.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { openIssue } from "./fake-pipeline-flow-gh.mjs";
import {
  binding,
  callMark,
  commentsOn,
  digest,
  dropRunFolders,
  plantComment,
  recordAttempt,
  recordKindsOn,
  recordResult,
  recordText,
  saveState,
  stateText,
  statusOf,
  statusRefusal,
  taskWorld,
  v2State,
  writesSince,
} from "./task-results-test-kit.mjs";

const ISSUE = 7;
const OTHER_ISSUE = 8;
const FORGED_ISSUES = 20;
const BUDGET = 3;
const SHA_LENGTH = 40;
const OTHER_CODE = "a".repeat(SHA_LENGTH);
const SUMMARY = "checked R on T";
const PASSED_RERUN = /no attempt may start: the binding is passed/u;
const EXHAUSTED = /the binding is exhausted/u;
const UNKNOWN = /the binding is unknown/u;
const REFUSED = /the binding is refused/u;
const CONFLICTING = /conflicting verdicts/u;
const NO_ATTEMPT = /no attempt with its binding/u;
const NOT_LATEST = /does not follow the binding's latest attempt/u;
const REUSED = /reused its identity/u;
const FOREIGN = /not the landing account's own record/u;
const UNREADABLE = /unreadable record/u;
const INVALID = /invalid record/u;
const MISBOUND = /another work item/u;
const REPEATED = /repeated an unsettled attempt/u;
const RERAN = /reran a passed binding/u;

/** @returns {string} */
function runId() {
  return crypto.randomUUID();
}

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
  /** @type {string[]} */
  const runs = [];
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

test("a refused Security subject stays refused under another target or policy", () => {
  const { flow, target } = taskWorld(ISSUE);
  const bound = binding({
    issue: ISSUE,
    task: "Security",
    code: target,
    target,
  });
  const run = runId();
  recordAttempt(flow, ISSUE, bound, { id: run, previous: null });
  recordResult(flow, ISSUE, bound, {
    run,
    verdict: "refused",
    summary: "user-harm: leaks addresses",
  });
  const moved = {
    ...bound,
    revision: { ...bound.revision, policy: digest("new policy") },
    target: { ...bound.target, commit: OTHER_CODE },
  };
  assert.equal(statusOf(flow, ISSUE, moved).status, "refused");
  const mark = callMark(flow.ghDir);
  const reroll = recordAttempt(flow, ISSUE, moved, {
    id: runId(),
    previous: run,
  });
  assert.match(String(reroll.error), REFUSED);
  assert.deepEqual(writesSince(flow.ghDir, mark), []);
  const changed = {
    ...moved,
    revision: { ...moved.revision, code: OTHER_CODE },
  };
  assert.equal(
    statusOf(flow, ISSUE, changed).status,
    "missing",
    "changed code is a new subject",
  );
});

// One work item's planted records: an attempt, its passed result and a
// retry that follows it.
/** @param {number} issue @param {string} target @param {{ first: string, second: string }} runs */
function issueRecords(issue, target, { first, second }) {
  const bound = binding({ issue, task: "Integration", code: target, target });
  const attempt = {
    version: 1,
    kind: "attempt",
    binding: bound,
    run: { id: first, previous: null },
  };
  const passed = {
    version: 1,
    kind: "result",
    binding: bound,
    run: { id: first },
    verdict: "passed",
    receipt: { summary: SUMMARY },
  };
  const retry = { ...attempt, run: { id: second, previous: first } };
  return { bound, attempt, passed, retry };
}

test("forged, malformed, misbound and raced records hold every read and append", () => {
  const { flow, target } = taskWorld(ISSUE);
  const runs = { first: runId(), second: runId() };
  /** @param {number} issue */
  function recordsFor(issue) {
    return issueRecords(issue, target, runs);
  }
  const cases = [
    {
      login: "dev-bot",
      why: FOREIGN,
      records: (/** @type {any} */ r) => [r.attempt, r.passed],
    },
    {
      login: "alice",
      why: FOREIGN,
      records: (/** @type {any} */ r) => [r.attempt, r.passed],
    },
    {
      login: "bot",
      why: INVALID,
      records: (/** @type {any} */ r) => [{ ...r.attempt, version: 2 }],
    },
    {
      login: "bot",
      why: MISBOUND,
      records: (/** @type {any} */ r) => [
        { ...r.attempt, binding: { ...r.bound, workItem: OTHER_ISSUE } },
      ],
    },
    {
      login: "bot",
      why: NO_ATTEMPT,
      records: (/** @type {any} */ r) => [r.passed],
    },
    // Two racing recorders that each read the binding as startable.
    {
      login: "bot",
      why: REPEATED,
      records: (/** @type {any} */ r) => [r.attempt, r.retry],
    },
    {
      login: "bot",
      why: RERAN,
      records: (/** @type {any} */ r) => [r.attempt, r.passed, r.retry],
    },
  ];
  const planted = cases.map(({ login, why, records }, index) => {
    const issue = FORGED_ISSUES + index;
    openIssue(flow.ghDir, {
      number: issue,
      title: "Forged",
      body: "",
      login: "alice",
    });
    for (const record of records(recordsFor(issue))) {
      plantComment(flow.ghDir, issue, login, recordText(record));
    }
    return { issue, why };
  });
  const unreadable = FORGED_ISSUES + cases.length;
  openIssue(flow.ghDir, {
    number: unreadable,
    title: "Forged",
    body: "",
    login: "alice",
  });
  plantComment(
    flow.ghDir,
    unreadable,
    "bot",
    "<!-- agent-pipeline:task-result\n{not json\n-->",
  );
  planted.push({ issue: unreadable, why: UNREADABLE });

  for (const { issue, why } of planted) {
    const { bound } = recordsFor(issue);
    const read = statusOf(flow, issue, bound);
    assert.equal(read.status, "held", `#${issue}`);
    assert.match(String(read.reason), why);
    const mark = callMark(flow.ghDir);
    assert.equal(
      recordAttempt(flow, issue, bound, { id: runId(), previous: null }).ok,
      false,
    );
    assert.deepEqual(writesSince(flow.ghDir, mark), []);
  }
  // A quoted mark inside other text is not a record claim.
  const own = recordsFor(ISSUE);
  plantComment(flow.ghDir, ISSUE, "alice", `See:\n${recordText(own.passed)}`);
  assert.equal(statusOf(flow, ISSUE, own.bound).status, "missing");
});

test("old saved state reads unchanged, its integration evidence is no result, and a stale save can't reach results", () => {
  const { flow, target } = taskWorld(ISSUE);
  const bound = binding({
    issue: ISSUE,
    task: "Integration",
    code: target,
    target,
  });
  const revision = { ...bound.revision };
  const reviewed = { repo: "o/r", branch: "integration", sha: target };
  // Everything the legacy writable Integration and its merge would have saved.
  const legacy = v2State(ISSUE, {
    hardened: revision,
    hardenedTarget: reviewed,
    integration: { reviewed: revision, revision },
    verifiedSha: target,
    security: {
      phase: "candidate",
      revision,
      target: reviewed,
      commentId: 5,
      finding: null,
    },
  });
  const stateId = plantComment(flow.ghDir, ISSUE, "bot", stateText(legacy));
  const original = commentsOn(flow.ghDir, ISSUE)[0]?.body;
  for (const task of ["Integration", "Security", "Land", "Hardening"]) {
    const read = statusOf(flow, ISSUE, { ...bound, task });
    assert.equal(
      read.status,
      "missing",
      `${task}: historical evidence is not a result`,
    );
  }

  const mark = callMark(flow.ghDir);
  const run = runId();
  recordAttempt(flow, ISSUE, bound, { id: run, previous: null });
  recordResult(flow, ISSUE, bound, {
    run,
    verdict: "failed",
    summary: "the greeting check failed on R",
  });
  assert.deepEqual(
    writesSince(flow.ghDir, mark).map((args) => args.includes("POST")),
    [true, true],
    "recording only appends; it never edits a comment",
  );
  assert.equal(
    commentsOn(flow.ghDir, ISSUE)[0]?.body,
    original,
    "the old state's bytes are unchanged",
  );
  const records = commentsOn(flow.ghDir, ISSUE).filter(
    (item) => item.id !== stateId,
  );

  // A stale snapshot saved over the state edits only the state comment.
  const stale = {
    ...legacy,
    integration: null,
    verifiedSha: null,
    log: ["stale"],
  };
  assert.equal(saveState(flow, ISSUE, stale).ok, true);
  const after = commentsOn(flow.ghDir, ISSUE).filter(
    (item) => item.id !== stateId,
  );
  assert.deepEqual(after, records);
  assert.partialDeepStrictEqual(statusOf(flow, ISSUE, bound), {
    status: "missing",
    attempts: 1,
  });
});
