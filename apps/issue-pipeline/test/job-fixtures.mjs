// @ts-check
// The stage job tests' fixtures: issue #7 as a claim wins it at a stage, the
// replies of the ops every stage job runs, and the author's replies and
// session, which job-test-kit.mjs's fake ops and fake pi play.
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";

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
const USAGE = { ...TOKENS, cacheWrite1h: TOKENS.cacheWrite, cost: 0.125 };
const USAGE_TOTAL =
  USAGE.input + USAGE.output + USAGE.cacheRead + USAGE.cacheWrite;
// What USAGE counts as spent towards reportedTokens: cache reads left out.
const USAGE_SPENT = USAGE.input + USAGE.output + USAGE.cacheWrite;

// The author's reply with the issue's first Gherkin.
const AUTHORED = {
  outcome: "gherkin",
  gherkin:
    "Feature: The thing\n\n  Scenario: It is done\n    Given src/a.ts\n    Then it does the thing",
  assumptions: [],
  wikiPages: [],
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
const GHERKIN_INPUTS =
  "0000000000000000000000000000000000000000000000000000000000000000";
// The account's signed Gherkin comment on issue #7, as the author posts it
// (src/gherkin-comment.ts), which the implementor's and reviewer's tasks
// read.
const GHERKIN_COMMENT = {
  id: 55,
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
// and wiki sync that change nothing, a verification and wiki check that pass
// at HEAD_SHA, and the PR made ready at that head.
const IMPLEMENT_OPS = {
  "start-pr": { ok: true, pr: PR, headSha: HEAD_SHA },
  "sync-base": { ok: true, conflict: false, changed: false },
  "wiki-sync": { ok: true, conflict: false, changed: false },
  verify: { ok: true, pass: true, headSha: HEAD_SHA, checks: [] },
  "wiki-check": { ok: true, pass: true, checks: [] },
  "open-pr": {
    ok: true,
    pr: PR,
    headSha: HEAD_SHA,
    codeChanged: true,
    wikiAhead: 0,
  },
};

// Issue #7's saved state at `stage`, with `fields` over a fresh one's.
/** @param {string} stage @param {Record<string, unknown>} [fields] */
function stateAt(stage, fields = {}) {
  return {
    version: 2,
    number: ISSUE_NUMBER,
    stage,
    stoppedStage: null,
    stopCode: null,
    resumeStage: null,
    lease: { lane: "L", sweepId: "s1", at: "2026-10-18T00:00:00.000Z" },
    pr: null,
    headSha: null,
    flows: null,
    gherkin: null,
    review: {
      round: 0,
      verdict: null,
      commentId: null,
      findings: [],
      revision: null,
    },
    verifiedSha: null,
    mergeReturn: null,
    merged: null,
    codeMerged: null,
    asked: null,
    counts: { conflictFixes: 0, syncs: 0 },
    log: [],
    ...fields,
  };
}

// The claim op's won reply (shared-ops-contract.md) for `state`: the
// issue's snapshot with no comments, and the PR branch at the saved head.
/**
 * @param {{ headSha?: unknown } & Record<string, unknown>} state
 * @param {readonly object[]} [comments] the issue's comments
 */
function claimWon(state, comments = []) {
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
const ROUTINE_OPS = {
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
/**
 * @param {string} stage
 * @param {Record<string, unknown>} [fields]
 * @returns {{ claim: object } & Record<string, unknown>}
 */
function repliesAt(stage, fields = {}) {
  return { ...ROUTINE_OPS, claim: claimWon(stateAt(stage, fields)) };
}

// Every op's reply for an implement job on issue #7 with its Gherkin, up to
// its session, its state with `fields`.
/**
 * @param {Record<string, unknown>} [fields]
 * @returns {{ claim: object } & Record<string, unknown>}
 */
function implementReplies(fields = {}) {
  const state = stateAt("implement", fields);
  return {
    ...ROUTINE_OPS,
    ...IMPLEMENT_OPS,
    claim: claimWon(state, [GHERKIN_COMMENT]),
  };
}

export {
  AFTER_READER_STAGE,
  ASKING,
  AUTHOR_SESSION,
  AUTHORED,
  COMMENT_ID,
  claimWon,
  GHERKIN_COMMENT,
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
  USAGE,
  USAGE_SPENT,
  USAGE_TOTAL,
};
