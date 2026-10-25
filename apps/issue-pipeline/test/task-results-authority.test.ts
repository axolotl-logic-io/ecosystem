// Who may record task results, and what old data means (#183): only the
// landing account's well-formed records count, a refused Security subject
// stays refused, and saved state and its historical evidence read unchanged.
// Every request is a fresh built ops process against the stateful fake GitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openIssue } from "./fake-pipeline-flow-gh.ts";
import {
  binding,
  callMark,
  commentsOn,
  digest,
  plantComment,
  recordAttempt,
  recordResult,
  recordText,
  runId,
  saveState,
  stateText,
  statusOf,
  taskWorld,
  v2State,
  writesSince,
} from "./task-results-test-kit.ts";

const ISSUE = 7;
const OTHER_ISSUE = 8;
const FORGED_ISSUES = 20;
const SHA_LENGTH = 40;
const OTHER_CODE = "a".repeat(SHA_LENGTH);
const SUMMARY = "checked R on T";
const REFUSED = /the binding is refused/u;
const NO_ATTEMPT = /no attempt with its binding/u;
const FOREIGN = /not the landing account's own record/u;
const UNREADABLE = /unreadable record/u;
const INVALID = /invalid record/u;
const MISBOUND = /another work item/u;
const REPEATED = /repeated an unsettled attempt/u;
const RERAN = /reran a passed binding/u;

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

// One work item's binding and its planted records.
interface IssueRecords {
  bound: ReturnType<typeof binding>;
  attempt: object;
  passed: object;
  retry: object;
}

// One work item's planted records: an attempt, its passed result and a
// retry that follows it.
function issueRecords(
  issue: number,
  target: string,
  { first, second }: { first: string; second: string },
): IssueRecords {
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
  function recordsFor(issue: number): IssueRecords {
    return issueRecords(issue, target, runs);
  }
  const cases = [
    {
      login: "dev-bot",
      why: FOREIGN,
      records: (r: IssueRecords): object[] => [r.attempt, r.passed],
    },
    {
      login: "alice",
      why: FOREIGN,
      records: (r: IssueRecords): object[] => [r.attempt, r.passed],
    },
    {
      login: "bot",
      why: INVALID,
      records: (r: IssueRecords): object[] => [{ ...r.attempt, version: 2 }],
    },
    {
      login: "bot",
      why: MISBOUND,
      records: (r: IssueRecords): object[] => [
        { ...r.attempt, binding: { ...r.bound, workItem: OTHER_ISSUE } },
      ],
    },
    {
      login: "bot",
      why: NO_ATTEMPT,
      records: (r: IssueRecords): object[] => [r.passed],
    },
    // Two racing recorders that each read the binding as startable.
    {
      login: "bot",
      why: REPEATED,
      records: (r: IssueRecords): object[] => [r.attempt, r.retry],
    },
    {
      login: "bot",
      why: RERAN,
      records: (r: IssueRecords): object[] => [r.attempt, r.passed, r.retry],
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
