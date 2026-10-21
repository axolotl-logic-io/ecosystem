// @ts-check
// The merge role's script for its tests: a hardened issue at merge whose
// every op succeeds, the merge queue, the security review of the merged
// result that finds nothing, and the replies after the merge.
import { opNames, sessionsOf } from "./reviewer-and-merge-role-calls-kit.mjs";
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
} from "./reviewer-and-merge-role-kit.mjs";

const QUEUE_HEAD = 7;
const QUEUE_NEXT = 12;

const REBASED = sha("1");
const QUEUE = [QUEUE_HEAD, QUEUE_NEXT];
const MERGED_PR = {
  number: PR,
  state: "MERGED",
  mergeCommit: MERGE_COMMIT,
  headSha: HEAD,
};
// After the merge, current-revision gives the merge commit as the code.
const AFTER_MERGE = current({ code: MERGE_COMMIT }, MERGED_PR);
const MERGED_REVISION = { code: MERGE_COMMIT, inputs: INPUTS };
const CODE_MERGED = { codeMerged: { pr: PR, sha: MERGE_COMMIT } };
const MUTATIONS = ["merge", "finish", "sync-base", "push", "ready-pr"];

const FINISHED = { finished: true, closed: true };
const CI_PASS = { status: "pass", checks: ["ci"] };
const MERGED = { merged: true, mergeCommit: MERGE_COMMIT, headSha: HEAD };
const PREPARED_MERGED = {
  headSha: MERGE_COMMIT,
  diffPath: "/run/security/diff.patch",
  bundlePath: "/run/security/bundle.md",
  changedFiles: ["src/chat.ts", "docs/Chats.md"],
};

// The Reviewer's own integration at merge: a failing CI check, the fix
// session's reply, and the ops of an integration that ends in a push of
// REBASED.
const CI_FAIL = { status: "fail", failing: ["e2e"], logPath: "/run/ci.log" };
const PUSHED = { headSha: REBASED, codeChanged: true };
const VERIFIED = { pass: true, headSha: REBASED, checks: [] };
const AFTER_INTEGRATION = {
  verify: [VERIFIED],
  push: [PUSHED],
};
const INTEGRATED = { ...REVISION, code: REBASED };
/** @type {import("../src/job/role-context.ts").SessionResult} */
const FIXED = {
  ok: true,
  reply: { outcome: "done", summary: "the e2e test waits for the list" },
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
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
      "ci-status": [CI_PASS],
      merge: [MERGED],
      "prepare-review": [PREPARED_MERGED],
      finish: [FINISHED],
      ...script.ops,
    },
    sessions: script.sessions ?? [NO_FINDING],
  });
}

/** The integration's writer sessions. @param {Parameters<typeof opNames>[0]} calls */
function integrationSessions(calls) {
  return sessionsOf(calls).filter((spec) => spec.phase === "integration");
}

/** The mutating ops the role ran, in order. @param {Parameters<typeof opNames>[0]} calls */
function mutationsOf(calls) {
  return opNames(calls).filter((name) => MUTATIONS.includes(name));
}

export {
  AFTER_INTEGRATION,
  AFTER_MERGE,
  CI_FAIL,
  CI_PASS,
  CODE_MERGED,
  FINISHED,
  FIXED,
  finding,
  INTEGRATED,
  integrationSessions,
  MERGED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  mutationsOf,
  NO_FINDING,
  PREPARED_MERGED,
  PUSHED,
  QUEUE,
  REBASED,
  VERIFIED,
};
