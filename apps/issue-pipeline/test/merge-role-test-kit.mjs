// @ts-check
// The merge role's script for its tests: a hardened issue at merge whose
// every op succeeds, the merge queue, the security review of the merged
// result that finds nothing, and the replies after the merge.
import { opNames } from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  current,
  fakeContext,
  HEAD,
  INPUTS,
  issueState,
  MERGE_COMMIT,
  PR,
  REVISION,
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
const MUTATIONS = [
  "merge",
  "publish",
  "finish-wiki",
  "sync-base",
  "wiki-sync",
  "push",
  "ready-pr",
];

const FINISHED = { finished: true, closed: true };
const WIKI_UNCHANGED = { conflict: false, changed: false, headSha: WIKI };
const WIKI_PASS = { pass: true, checks: [] };
const CI_PASS = { status: "pass", checks: ["ci"] };
const MERGED = { merged: true, mergeCommit: MERGE_COMMIT, headSha: HEAD };
const PUBLISHED = {
  published: true,
  sha: WIKI,
  commits: [`${WIKI.slice(0, SHORT_COMMIT_LENGTH)} Chats`],
};
const PREPARED_MERGED = {
  headSha: MERGE_COMMIT,
  diffPath: "/run/security/diff.patch",
  bundlePath: "/run/security/bundle.md",
  changedFiles: ["src/chat.ts", "wiki/Chats.md"],
};

/** @type {import("../src/job/role-context.ts").SessionResult} */
const NO_FINDING = {
  ok: true,
  reply: { summary: "Nothing harms users.", security: null },
};

/**
 * A security review that finds a harm of `category`.
 * @param {"user-harm" | "rights" | "financial-harm" | "abuse-risk"} category
 * @returns {import("../src/job/role-context.ts").SessionResult}
 */
function finding(category) {
  return {
    ok: true,
    reply: {
      summary: "The list leaks other users' chats.",
      security: { category, reason: "src/chat.ts:12 drops the owner scope" },
    },
  };
}

/**
 * @param {{
 *   state?: Partial<import("../src/state.ts").IssueState>,
 *   ops?: Record<string, unknown[]>,
 *   sessions?: import("../src/job/role-context.ts").SessionResult[],
 *   gherkin?: import("../src/gherkin-comment.ts").GherkinComment | null,
 *   config?: Partial<import("../src/config.ts").Config>,
 * }} [script]
 */
function merging(script = {}) {
  return fakeContext({
    stage: "merge",
    state: issueState({
      stage: "merge",
      hardened: REVISION,
      ...script.state,
    }),
    gherkin: script.gherkin,
    mergeQueue: QUEUE,
    config: script.config,
    ops: {
      "current-revision": [current(), current(), AFTER_MERGE, AFTER_MERGE],
      "wiki-check": [WIKI_PASS],
      "ci-status": [CI_PASS],
      merge: [MERGED],
      "prepare-review": [PREPARED_MERGED],
      publish: [PUBLISHED],
      "finish-wiki": [FINISHED],
      ...script.ops,
    },
    sessions: script.sessions ?? [NO_FINDING],
  });
}

/** The mutating ops the role ran, in order. @param {Parameters<typeof opNames>[0]} calls */
function mutationsOf(calls) {
  return opNames(calls).filter((name) => MUTATIONS.includes(name));
}

export {
  AFTER_MERGE,
  CI_PASS,
  CODE_MERGED,
  FINISHED,
  finding,
  MERGED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  mutationsOf,
  NO_FINDING,
  PREPARED_MERGED,
  PUBLISHED,
  QUEUE,
  REBASED,
  WIKI_PASS,
  WIKI_UNCHANGED,
};
