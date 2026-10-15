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

const LIVE = new Date().toISOString();
const LAPSED = "2020-01-01T00:00:00Z";
const LANE = { lane: "me", sweepId: "s1" };

// gh's reply to getIssue for issue `n`, open and unlabelled unless `extra`
// says otherwise.
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

function getIssue(n) {
  return ["api", `repos/o/r/issues/${n}`];
}

// The gh call that looks for an open PR from issue `n`'s branch.
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

function postClaim(n) {
  return ghCalls.postRaw(
    n,
    `**🤖 issue-pipeline · claim**\n<sub>deterministic step, no model · run \`s1\`</sub>\n<!-- agent-pipeline:comment role=claim -->\n\n${CLAIM_TEXT}\n<!-- agent-pipeline:claim lane=me sweep=s1 -->`,
  );
}

function postState(n, state) {
  return ghCalls.post(n, stateBody(n, state));
}

function patchState(n, id, state) {
  return ghCalls.patch(id, stateBody(n, state));
}

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
