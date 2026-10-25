// The stage job tests' fixtures: issue #7 as a claim wins it at a stage, the
// replies of the ops every stage job runs, and the author's replies and
// session, which job-test-kit.ts's fake ops and fake pi play.
import { createHash } from "node:crypto";
import { trustedInputBytes } from "../src/trusted-inputs.ts";
import { messageEnd, outputEnd } from "./fake-rpc-pi.ts";

// The issue every job test runs for, and the trusted user who opened it.
const ISSUE_NUMBER = 7;
const ISSUE = {
  title: "Do the thing",
  body: "src/a.ts should do the thing.",
  user: { login: "alice" },
};
// The id of every comment the fake post op writes.
const COMMENT_ID = 101;
// Its cache writes all last an hour, and its cost is exact in binary.
const TOKENS = { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 400 };
const USAGE: {
  cacheWrite1h: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} = { ...TOKENS, cacheWrite1h: TOKENS.cacheWrite, cost: 0.125 };
const USAGE_TOTAL: number =
  USAGE.input + USAGE.output + USAGE.cacheRead + USAGE.cacheWrite;
// What USAGE counts as spent towards reportedTokens: cache reads left out.
const USAGE_SPENT: number = USAGE.input + USAGE.output + USAGE.cacheWrite;

// The author's reply with the issue's first Gherkin.
const AUTHORED = {
  outcome: "gherkin",
  gherkin:
    "Feature: The thing\n\n  Scenario: It is done\n    Given src/a.ts\n    Then it does the thing",
  assumptions: [],
  changed: true,
};
// The author's reply asking its questions.
const ASKING = {
  outcome: "needs-info",
  questions: ["Which thing?"],
};
// The stage the job tests run when any one-session reader stage will do:
// the author, whose Gherkin sends the issue on to implement.
const READER_STAGE = "author";
const AFTER_READER_STAGE = "implement";
// An author session that spends USAGE and ends with the Gherkin.
const AUTHOR_SESSION = { events: [messageEnd(USAGE), outputEnd(AUTHORED)] };

// The PR the implementor's start-pr opens, and the head it pushes.
const PR = 42;
const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// The trusted-inputs revision the Gherkin comment was written at.
const GHERKIN_INPUTS = createHash("sha256")
  .update(trustedInputBytes(ISSUE, []))
  .digest("hex");
// The account's signed Gherkin comment on issue #7, as the author posts it
// (src/gherkin-comment.ts), which the implementor's and reviewer's tasks
// read.
const GHERKIN_COMMENT: {
  user: { login: string };
  body: string;
  lastEditedAt: null;
  editor: null;
  id: number;
} = {
  id: 55,
  ...Object.fromEntries([["node_id", "comment-55"]]),
  lastEditedAt: null,
  editor: null,
  // GitHub's field names aren't camelCase.
  ...Object.fromEntries([["created_at", "2026-10-18T00:00:00Z"]]),
  user: { login: "bot" },
  body: [
    "## Behaviour",
    "",
    "```gherkin",
    AUTHORED.gherkin,
    "```",
    "",
    `<!-- issue-pipeline:gherkin rev=1 inputs=${GHERKIN_INPUTS} -->`,
    "<!-- agent-pipeline:comment role=author -->",
    `<!-- issue-pipeline:${ISSUE_NUMBER}:gherkin -->`,
  ].join("\n"),
};
// The implementor's reply when its work is done.
const IMPLEMENTED = { outcome: "done", summary: "src/a.ts does the thing." };
// An implementor session that spends USAGE and ends with its work done.
const IMPLEMENTOR_SESSION = {
  events: [messageEnd(USAGE), outputEnd(IMPLEMENTED)],
};
// The ops an implement job runs around its session: the draft PR, a code
// sync that changes nothing, a verification that passes at HEAD_SHA, and the
// PR made ready at that head.
const IMPLEMENT_OPS: Record<string, object> = {
  "start-pr": { ok: true, pr: PR, headSha: HEAD_SHA },
  "sync-base": { ok: true, conflict: false, changed: false },
  verify: { ok: true, pass: true, headSha: HEAD_SHA, checks: [] },
  "open-pr": {
    ok: true,
    pr: PR,
    headSha: HEAD_SHA,
    codeChanged: true,
  },
};

// Issue #7's saved state at `stage`, with `fields` over a fresh one's.
function stateAt(
  stage: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    number: ISSUE_NUMBER,
    stage,
    stoppedStage: null,
    stopCode: null,
    resumeStage: null,
    lease: { lane: "L", sweepId: "s1", at: "2026-10-18T00:00:00.000Z" },
    pr: null,
    branch: null,
    headSha: null,
    flows: null,
    gherkin: null,
    authorUsed: true,
    requirementsInputs: null,
    review: {
      round: 0,
      verdict: null,
      commentId: null,
      findings: [],
      revision: null,
    },
    hardened: null,
    hardenedTarget: null,
    integration: null,
    security: null,
    verifiedSha: null,
    mergeReturn: null,
    merged: null,
    codeMerged: null,
    mergeAttempt: null,
    asked: null,
    counts: { conflictFixes: 0, syncs: 0 },
    log: [],
    ...fields,
  };
}

// A claim op's won reply.
interface ClaimWonReply {
  ok: boolean;
  state: Record<string, unknown>;
  claim: { id: number; posted: boolean };
  remoteHead: unknown;
  issueFile: string;
  issue: { title: string; body: string; user: { login: string } };
  comments: readonly object[];
}

// The claim op's won reply (shared-ops-contract.md) for `state`: the
// issue's snapshot with no comments, and the PR branch at the saved head.
// comments: the issue's comments
function claimWon(
  state: { headSha?: unknown } & Record<string, unknown>,
  comments: readonly object[] = [],
): ClaimWonReply {
  return {
    ok: true,
    state,
    claim: { id: 1, posted: true },
    remoteHead: state.headSha ?? null,
    issueFile: "/w/runs/o__r/issue-7/issue.md",
    issue: ISSUE,
    comments,
  };
}

// The replies of the ops every stage job runs.
// The chain's next ready task for revision HEAD_SHA on its target, which a
// review job reads before it hardens (#186): Hardening, not yet recorded,
// after a current Implementation result that produced HEAD_SHA (#118).
const READY_FOR_HARDENING: Record<string, unknown> = {
  ok: true,
  revision: {
    code: HEAD_SHA,
    inputs: GHERKIN_INPUTS,
    policy: "c".repeat(GHERKIN_INPUTS.length),
  },
  target: { branch: "main", commit: "b".repeat(HEAD_SHA.length) },
  contains: true,
  implemented: HEAD_SHA,
  next: {
    task: "Hardening",
    binding: {
      repo: "o/r",
      workItem: ISSUE_NUMBER,
      task: "Hardening",
      revision: {
        code: HEAD_SHA,
        inputs: GHERKIN_INPUTS,
        policy: "c".repeat(GHERKIN_INPUTS.length),
      },
      target: { branch: "main", commit: "b".repeat(HEAD_SHA.length) },
    },
    status: "missing",
  },
  hold: null,
};

// The status an implement job reads before it records Implementation's
// result (#118): already passed, so it records nothing more.
const IMPLEMENTATION_PASSED: {
  ok: boolean;
  status: string;
  result: {
    run: { id: string };
    receipt: { summary: string; produced: { code: string } };
  };
  attempts: number;
  latest: string;
} = {
  ok: true,
  status: "passed",
  result: {
    run: { id: "00000000-0000-4000-8000-000000000001" },
    receipt: { summary: "implemented", produced: { code: HEAD_SHA } },
  },
  attempts: 1,
  latest: "00000000-0000-4000-8000-000000000001",
};

const ROUTINE_OPS: Record<string, object> = {
  "task-readiness": READY_FOR_HARDENING,
  "task-result": IMPLEMENTATION_PASSED,
  "save-state": { ok: true },
  release: { ok: true },
  stop: { ok: true },
  ask: { ok: true },
  usage: { ok: true },
  post: { ok: true, posted: 1, commentIds: [COMMENT_ID] },
  "exit-push": { ok: true },
  push: { ok: true },
  cleanup: { ok: true },
};

// Every op's reply for a job whose claim wins issue #7 at `stage`, its
// state with `fields`.
function repliesAt(
  stage: string,
  fields: Record<string, unknown> = {},
): { claim: object } & Record<string, unknown> {
  return { ...ROUTINE_OPS, claim: claimWon(stateAt(stage, fields)) };
}

// Every op's reply for an implement job on issue #7 with its Gherkin, up to
// its session, its state with `fields`.
function implementReplies(
  fields: Record<string, unknown> = {},
): { claim: object } & Record<string, unknown> {
  const state = stateAt("implement", fields);
  return {
    ...ROUTINE_OPS,
    ...IMPLEMENT_OPS,
    claim: claimWon(state, [GHERKIN_COMMENT]),
  };
}

// An invocation binding for tests that drive the control socket in process.
const TEST_BINDING: {
  instance: string;
  lane: string;
  issue: number;
  branch: string;
  repo: string;
  base: string;
} = {
  instance: "00000000-0000-4000-8000-000000000007",
  lane: "L",
  issue: ISSUE_NUMBER,
  branch: "agent/issue-7",
  repo: "o/r",
  base: "main",
};

export type { ClaimWonReply };
export {
  AFTER_READER_STAGE,
  ASKING,
  AUTHOR_SESSION,
  AUTHORED,
  COMMENT_ID,
  claimWon,
  GHERKIN_COMMENT,
  GHERKIN_INPUTS,
  HEAD_SHA,
  IMPLEMENT_OPS,
  IMPLEMENTED,
  IMPLEMENTOR_SESSION,
  ISSUE,
  implementReplies,
  PR,
  READER_STAGE,
  ROUTINE_OPS,
  repliesAt,
  stateAt,
  TEST_BINDING,
  USAGE,
  USAGE_SPENT,
  USAGE_TOTAL,
};
