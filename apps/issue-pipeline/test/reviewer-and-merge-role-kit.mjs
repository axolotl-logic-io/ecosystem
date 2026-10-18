// @ts-check
// A fake RoleContext for the reviewer and merge role tests: scripted op
// replies and session results, and one log of every call the role made, so
// a test can assert what the role did, and what came right before a
// mutation, without pinning the rest of the order. The pipeline's root and
// home are a temporary folder, set before any pipeline module is imported.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "review-merge-role-"));
process.env.HOME = sandbox;
process.env.ISSUE_PIPELINE_ROOT = path.join(sandbox, "root");
process.env.PI_CODING_AGENT_DIR = path.join(sandbox, "agent");
process.on("exit", () => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { ROOT } = await import("../src/pipeline-root.ts");
assert.ok(
  ROOT.startsWith(sandbox),
  `the pipeline root ${ROOT} is not the test's temporary folder`,
);
const { testConfig } = await import("./config-test-kit.mjs");
const { newIssueState } = await import("../src/state.ts");
const { reviewerRole } = await import("../src/roles/reviewer/reviewer.ts");
const { mergeRole } = await import("../src/roles/merge/merge.ts");

const { cfg } = testConfig();

const ISSUE = 7;
const PR = 90;
const HEAD = "c".repeat(40);
const WIKI = "d".repeat(40);
const INPUTS = "a".repeat(64);
const MERGE_COMMIT = "e".repeat(40);
const GHERKIN_TEXT =
  "Feature: Chats\n  Scenario: list\n    Given a chat\n    Then it is listed";

/** @type {import("../src/state.ts").Revision} */
const REVISION = { code: HEAD, wiki: WIKI, inputs: INPUTS };

/**
 * @typedef {{ kind: "op", name: string, payload: any }
 *   | { kind: "session", spec: import("../src/job/role-context.ts").SessionSpec }
 *   | { kind: "post", comment: import("../src/job/role-context.ts").PostedComment }
 *   | { kind: "save", state: import("../src/state.ts").IssueState }} Call
 * @typedef {(payload: any) => unknown} OpReply
 */

/**
 * The current-revision op's reply.
 * @param {Partial<import("../src/state.ts").Revision>} [revision]
 * @param {{ number: number, state: string, mergeCommit: string | null } | null} [pr]
 */
function current(revision = {}, pr = { number: PR, state: "OPEN", mergeCommit: null }) {
  return { revision: { ...REVISION, ...revision }, baseSha: "b".repeat(40), pr };
}

/**
 * @param {Partial<import("../src/state.ts").IssueState>} [state]
 * @returns {import("../src/state.ts").IssueState}
 */
function issueState(state = {}) {
  return {
    ...newIssueState(ISSUE),
    pr: PR,
    headSha: HEAD,
    verifiedSha: HEAD,
    flows: { code: true, wiki: true },
    ...state,
  };
}

/** @param {Partial<import("../src/state.ts").IssueState["review"]>} [review] */
function approvedReview(review = {}) {
  return {
    round: 0,
    verdict: /** @type {const} */ ("approve"),
    commentId: 5,
    findings: [],
    revision: REVISION,
    ...review,
  };
}

/** @param {Partial<import("../src/gherkin-comment.ts").GherkinComment>} [gherkin] */
function gherkinComment(gherkin = {}) {
  return {
    id: 41,
    rev: 2,
    inputs: INPUTS,
    gherkin: GHERKIN_TEXT,
    assumptions: ["the list is newest first"],
    wikiPages: ["Chats"],
    ...gherkin,
  };
}

/**
 * A fake RoleContext. `ops` gives each op's replies in turn: a value, or a
 * function of the payload. An op with no reply left fails the test, so an
 * unexpected op, a mutation above all, never passes unseen.
 * @param {{
 *   stage: import("../src/stages.ts").Stage,
 *   state: import("../src/state.ts").IssueState,
 *   ops?: Record<string, unknown[]>,
 *   sessions?: import("../src/job/role-context.ts").SessionResult[],
 *   gherkin?: ReturnType<typeof gherkinComment> | null,
 *   mergeQueue?: readonly number[] | null,
 *   config?: Record<string, unknown>,
 * }} script
 */
function fakeContext(script) {
  /** @type {Call[]} */
  const calls = [];
  /** @type {Record<string, unknown[]>} */
  const ops = Object.fromEntries(
    Object.entries(script.ops ?? {}).map(([name, replies]) => [name, [...replies]]),
  );
  const sessions = [...(script.sessions ?? [])];
  /** @type {any} */
  const ctx = {
    cfg: { ...cfg, ...script.config },
    issue: ISSUE,
    stage: script.stage,
    state: script.state,
    dirs: { job: "/job", repo: "/job/repo", docs: "/job/docs" },
    issueFile: "/run/issue.md",
    inputs: {
      issue: { title: "T", body: "B", user: { login: "owner" } },
      comments: [],
      revision: INPUTS,
      gherkin: script.gherkin === undefined ? gherkinComment() : script.gherkin,
    },
    mergeQueue: script.mergeQueue === undefined ? null : script.mergeQueue,
    /** @param {string} name @param {any} payload */
    op: (name, payload) => {
      calls.push({ kind: "op", name, payload });
      const replies = ops[name];
      if (replies === undefined || replies.length === 0) {
        return Promise.reject(new Error(`unexpected op ${name}`));
      }
      const reply = replies.shift();
      if (typeof reply === "function") {
        return Promise.resolve().then(() => reply(payload));
      }
      return Promise.resolve(reply);
    },
    /** @param {import("../src/job/role-context.ts").SessionSpec} spec */
    session: (spec) => {
      calls.push({ kind: "session", spec });
      const result = sessions.shift();
      if (result === undefined) {
        return Promise.reject(new Error("unexpected session"));
      }
      return Promise.resolve(result);
    },
    /** @param {import("../src/job/role-context.ts").PostedComment} comment */
    post: (comment) => {
      calls.push({ kind: "post", comment });
      return Promise.resolve(51);
    },
    /** @param {import("../src/state.ts").IssueState} state */
    save: (state) => {
      calls.push({ kind: "save", state });
      return Promise.resolve();
    },
  };
  /** @type {import("../src/job/role-context.ts").RoleContext} */
  const roleContext = ctx;
  return { ctx: roleContext, calls };
}

/** @param {Call[]} calls */
function opNames(calls) {
  return calls.flatMap((call) => (call.kind === "op" ? [call.name] : []));
}

/** @param {Call[]} calls @param {string} name */
function opPayloads(calls, name) {
  return calls.flatMap((call) =>
    call.kind === "op" && call.name === name ? [call.payload] : [],
  );
}

/**
 * Asserts the call right before each `name` op was a current-revision op:
 * the mutation's fresh precondition.
 * @param {Call[]} calls @param {string} name
 */
function assertFreshBefore(calls, name) {
  const at = calls.findIndex((call) => call.kind === "op" && call.name === name);
  assert.ok(at > 0, `no ${name} op`);
  const before = calls[at - 1];
  assert.ok(
    before?.kind === "op" && before.name === "current-revision",
    `the call before ${name} was not current-revision`,
  );
}

/** @param {Call[]} calls */
function sessionsOf(calls) {
  return calls.flatMap((call) => (call.kind === "session" ? [call.spec] : []));
}

/** @param {Call[]} calls */
function postsOf(calls) {
  return calls.flatMap((call) => (call.kind === "post" ? [call.comment] : []));
}

/** @param {Call[]} calls */
function savesOf(calls) {
  return calls.flatMap((call) => (call.kind === "save" ? [call.state] : []));
}

/**
 * The end's state, failing unless the end is `kind`.
 * @param {import("../src/job/role-context.ts").RoleEnd} end
 * @param {"next" | "stop" | "ask" | "wait"} kind
 */
function stateOf(end, kind) {
  assert.equal(end.kind, kind, JSON.stringify(end));
  assert.ok(end.kind !== "deferred");
  return end.state;
}

export {
  approvedReview,
  assertFreshBefore,
  cfg,
  current,
  fakeContext,
  gherkinComment,
  GHERKIN_TEXT,
  HEAD,
  INPUTS,
  issueState,
  MERGE_COMMIT,
  mergeRole,
  opNames,
  opPayloads,
  PR,
  postsOf,
  REVISION,
  reviewerRole,
  savesOf,
  sessionsOf,
  stateOf,
  WIKI,
};
