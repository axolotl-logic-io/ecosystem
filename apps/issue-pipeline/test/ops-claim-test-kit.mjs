// @ts-check
// The claim op's requests, gh replies and replies, as the ops-claim tests
// use them, with version 2 states.
import path from "node:path";
import {
  ACCOUNT,
  runDir,
  TIME,
  timeless,
  worktree,
} from "./ops-cli-test-kit.mjs";

const { newIssueState } = await import("../src/state.ts");

/** @import { GhReply } from "./fake-gh.mjs" */
/** @import { IssueState } from "../src/state.ts" */

const LIVE = new Date().toISOString();
const LAPSED = "2020-01-01T00:00:00Z";
const LANE = { lane: "me", sweepId: "s1" };

// Issue `n` as GitHub gives it: open and unlabelled unless `extra` says
// otherwise.
/** @param {number} n @param {object} [extra] @returns {Record<string, unknown>} */
function issueOf(n, extra = {}) {
  return {
    number: n,
    title: `Issue ${n}`,
    body: "",
    state: "open",
    user: { login: ACCOUNT },
    labels: [],
    ...extra,
  };
}

// gh's reply to getIssue for issue `n`, open and unlabelled unless `extra`
// says otherwise.
/** @param {number} n @param {object} [extra] @returns {GhReply} */
function issueReply(n, extra = {}) {
  return {
    when: `api repos/o/r/issues/${n}`,
    stdout: JSON.stringify(issueOf(n, extra)),
  };
}

// The marker the wiki promises on a live claim by lane `me` of sweep `s1`.
const CLAIM_MARK = "<!-- agent-pipeline:claim lane=me sweep=s1 -->";
const LEASE = { lane: "me", sweepId: "s1", at: TIME };

// The state a claim by lane `me` saves for issue `n`: a new issue's,
// leased, with `extra` over it.
/** @param {number} n @param {Partial<IssueState>} [extra] @returns {IssueState} */
function claimedState(n, extra = {}) {
  return { ...newIssueState(n), lease: LEASE, ...extra };
}

// The paths a won claim of issue `n` replies with.
/** @param {number} n @param {string | null} [wiki] @returns {{ worktree: string, runDir: string, issueFile: string, wiki: string | null }} */
function claimPaths(n, wiki = null) {
  const issueFile = path.join(runDir(n), "issue.md");
  return { worktree: worktree(n), runDir: runDir(n), issueFile, wiki };
}

/**
 * A won claim's reply for issue `n`: the issue and comments it read (an
 * open, unlabelled issue with none unless `extra` says otherwise), with
 * their times replaced as the reply's are, the issue file it wrote, and
 * `extra` over the rest.
 * @param {number} n @param {{ issue?: object, comments?: readonly unknown[] } & Record<string, unknown>} [extra]
 * @returns {object}
 */
function claimReply(n, extra = {}) {
  const { issue = issueOf(n), comments = [], ...rest } = extra;
  const paths = claimPaths(n);
  return {
    ok: true,
    op: "claim",
    posted: 0,
    commentIds: [],
    remoteHead: null,
    issueFile: paths.issueFile,
    issue,
    comments: JSON.parse(timeless(JSON.stringify(comments))),
    paths,
    ...rest,
  };
}

export {
  CLAIM_MARK,
  claimedState,
  claimReply,
  issueOf,
  issueReply,
  LANE,
  LAPSED,
  LEASE,
  LIVE,
};
