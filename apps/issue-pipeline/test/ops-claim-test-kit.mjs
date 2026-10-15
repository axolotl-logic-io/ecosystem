// @ts-check
// The claim op's requests, gh replies, gh calls and replies, as
// ops-claim.test.mjs pins them.
import path from "node:path";
import {
  ACCOUNT,
  ghCalls,
  runDir,
  stateBody,
  TIME,
  worktree,
} from "./ops-cli-test-kit.mjs";

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

/** @param {number} n @returns {string[]} */
function getIssue(n) {
  return ["api", `repos/o/r/issues/${n}`];
}

// The gh call that looks for an open PR from issue `n`'s branch.
/** @param {number} n @returns {string[]} */
function listOpenPrs(n) {
  return [
    "pr",
    "list",
    "-R",
    "o/r",
    "--head",
    `agent/issue-${n}`,
    "--state",
    "open",
    "--json",
    "number",
  ];
}

const CLAIM_TEXT =
  "Lane `me` is claiming this issue. If another lane claimed it first, this lane abandons it and takes another issue.";
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
  continuations: 0,
  round: 0,
  ciFixes: 0,
  syncs: 0,
  findings: [],
  resolvedHistory: [],
  questionsAt: null,
  log: [],
};

/** @param {number} n @returns {string[]} */
function postClaim(n) {
  return ghCalls.postRaw(
    n,
    `**🤖 issue-pipeline · claim**\n<sub>deterministic step, no model · run \`s1\`</sub>\n<!-- agent-pipeline:comment role=claim -->\n\n${CLAIM_TEXT}\n<!-- agent-pipeline:claim lane=me sweep=s1 -->`,
  );
}

/** @param {number} n @param {object} state @returns {string[]} */
function postState(n, state) {
  return ghCalls.post(n, stateBody(n, state));
}

/** @param {number} n @param {number} id @param {object} state @returns {string[]} */
function patchState(n, id, state) {
  return ghCalls.patch(id, stateBody(n, state));
}

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
  claimReply,
  getIssue,
  issueReply,
  LANE,
  LAPSED,
  LEASE,
  LIVE,
  listOpenPrs,
  NEW_STATE,
  patchState,
  postClaim,
  postState,
};
