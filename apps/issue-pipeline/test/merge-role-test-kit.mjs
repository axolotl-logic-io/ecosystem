// @ts-check
// The merge role's script for its tests: an approved issue at merge whose
// every op succeeds, the merge queue, and the replies after the merge.
import { opNames } from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  approvedReview,
  current,
  fakeContext,
  INPUTS,
  issueState,
  MERGE_COMMIT,
  PR,
  sha,
  WIKI,
} from "./reviewer-and-merge-role-kit.mjs";

const SHORT_COMMIT_LENGTH = 7;
const QUEUE_HEAD = 7;
const QUEUE_NEXT = 12;

const REBASED = sha("1");
const QUEUE = [QUEUE_HEAD, QUEUE_NEXT];
const MERGED_PR = { number: PR, state: "MERGED", mergeCommit: MERGE_COMMIT };
// After the merge, current-revision gives the merge commit as the code.
const AFTER_MERGE = current({ code: MERGE_COMMIT }, MERGED_PR);
const MERGED_REVISION = { code: MERGE_COMMIT, wiki: WIKI, inputs: INPUTS };
const CODE_MERGED = { codeMerged: { pr: PR, sha: MERGE_COMMIT } };
const MUTATIONS = ["merge", "publish", "finish-wiki", "sync-base", "wiki-sync"];

const FINISHED = { finished: true, closed: true };
const WIKI_UNCHANGED = { conflict: false, changed: false, headSha: WIKI };
const WIKI_PASS = { pass: true, checks: [] };
const CI_PASS = { status: "pass", checks: ["ci"] };
const PUBLISHED = {
  published: true,
  sha: WIKI,
  commits: [`${WIKI.slice(0, SHORT_COMMIT_LENGTH)} Chats`],
};

/**
 * @param {{
 *   state?: Partial<import("../src/state.ts").IssueState>,
 *   ops?: Record<string, unknown[]>,
 *   gherkin?: import("../src/gherkin-comment.ts").GherkinComment | null,
 *   config?: Partial<import("../src/config.ts").Config>,
 * }} [script]
 */
function merging(script = {}) {
  return fakeContext({
    stage: "merge",
    state: issueState({
      stage: "merge",
      review: approvedReview(),
      ...script.state,
    }),
    gherkin: script.gherkin,
    mergeQueue: QUEUE,
    config: script.config,
    ops: {
      "current-revision": [current(), current(), AFTER_MERGE],
      "wiki-sync": [WIKI_UNCHANGED],
      "wiki-check": [WIKI_PASS],
      "ci-status": [CI_PASS],
      merge: [{ merged: true, mergeCommit: MERGE_COMMIT }],
      publish: [PUBLISHED],
      "finish-wiki": [FINISHED],
      ...script.ops,
    },
  });
}

/** The mutating ops the role ran, in order. @param {Parameters<typeof opNames>[0]} calls */
function mutationsOf(calls) {
  return opNames(calls).filter((name) => MUTATIONS.includes(name));
}

export {
  AFTER_MERGE,
  CODE_MERGED,
  FINISHED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  mutationsOf,
  QUEUE,
  REBASED,
};
