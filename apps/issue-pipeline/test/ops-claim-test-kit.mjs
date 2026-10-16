// @ts-check
// The claim op's requests, gh replies and replies, as the ops-claim tests
// use them.
import path from "node:path";
import { ACCOUNT, runDir, TIME, worktree } from "./ops-cli-test-kit.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */

const LIVE = new Date().toISOString();
const LAPSED = "2020-01-01T00:00:00Z";
const LANE = { lane: "me", sweepId: "s1" };

// gh's reply to getIssue for issue `n`, open and unlabelled unless `extra`
// says otherwise.
/** @param {number} n @param {object} [extra] @returns {GhReply} */
function issueReply(n, extra = {}) {
  const issue = {
    number: n,
    title: `Issue ${n}`,
    body: "",
    state: "open",
    user: { login: ACCOUNT },
    labels: [],
    ...extra,
  };
  return { when: `api repos/o/r/issues/${n}`, stdout: JSON.stringify(issue) };
}

// The marker the wiki promises on a live claim by lane `me` of sweep `s1`.
const CLAIM_MARK = "<!-- agent-pipeline:claim lane=me sweep=s1 -->";
const LEASE = { lane: "me", sweepId: "s1", at: TIME };
const NEW_STATE = {
  version: 1,
  number: 0,
  depth: 0,
  stage: "triage",
  lease: LEASE,
  pr: null,
  headSha: null,
  reviewedSha: null,
  verifiedSha: null,
  plan: null,
  allocated: 0,
  rebaseAllocated: 0,
  rechecking: false,
  reportedTokens: 0,
  sessions: [],
  triages: 0,
  continuations: {},
  round: 0,
  ciFixes: 0,
  syncs: 0,
  findings: [],
  resolvedHistory: [],
  questionsAt: null,
  log: [],
};

/** @param {number} n @param {string | null} [wiki] @returns {object} */
function claimPaths(n, wiki = null) {
  return {
    worktree: worktree(n),
    runDir: runDir(n),
    issueFile: path.join(runDir(n), "issue.md"),
    handoffFile: path.join(runDir(n), "handoff.md"),
    wiki,
  };
}

// A won claim's reply for issue `n`, with `extra` over the defaults.
/** @param {number} n @param {object} [extra] @returns {object} */
function claimReply(n, extra) {
  return {
    ok: true,
    op: "claim",
    posted: 0,
    remoteHead: null,
    paths: claimPaths(n),
    ...extra,
  };
}

export {
  CLAIM_MARK,
  claimReply,
  issueReply,
  LANE,
  LAPSED,
  LEASE,
  LIVE,
  NEW_STATE,
};
