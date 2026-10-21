// @ts-check
// A fake RoleContext for the reviewer and merge role tests: scripted op
// replies and session results, and one log of every call the role made, so
// a test can assert what the role did, and what came right before a
// mutation, without pinning the rest of the order. The pipeline's root and
// home are a temporary folder, set before any pipeline module is imported.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "review-merge-role-"));
const sandboxRoot = path.join(sandbox, "root");
// src runs its commands in the root, so it must exist.
fs.mkdirSync(sandboxRoot);
// Names are the environment's own, set as entries.
Object.assign(
  process.env,
  Object.fromEntries([
    ["HOME", sandbox],
    ["ISSUE_PIPELINE_ROOT", sandboxRoot],
    ["PI_CODING_AGENT_DIR", path.join(sandbox, "agent")],
  ]),
);
process.on("exit", () => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { ROOT } = await import("../src/pipeline-root.ts");
if (ROOT !== sandboxRoot) {
  throw new Error(
    `the pipeline root ${ROOT} is not the test's temporary folder`,
  );
}
const { testConfig } = await import("./config-test-kit.mjs");
const { newIssueState } = await import("../src/state.ts");
const { reviewerRole } = await import("../src/roles/reviewer/reviewer.ts");
const { mergeRole } = await import("../src/roles/merge/merge.ts");

const { cfg } = testConfig();
// The loop bounds the roles read from the config, which its defaults fill in.
const LIMITS = z
  .looseObject({
    maxSyncs: z.number().int().nonnegative(),
    maxCiFixes: z.number().int().nonnegative(),
    maxConflictFixes: z.number().int().nonnegative(),
  })
  .parse(cfg);

const ISSUE = 7;
const PR = 90;
const COMMENT_ID = 51;
const APPROVAL_COMMENT_ID = 5;
const GHERKIN_COMMENT_ID = 41;
const GHERKIN_REV = 2;
const SHA_LENGTH = 40;
const INPUTS_LENGTH = 64;
const SHORT_SHA_LENGTH = 12;

/** A commit oid of one repeated character. @param {string} char */
function sha(char) {
  return char.repeat(SHA_LENGTH);
}

/** A trusted-inputs revision of one repeated character. @param {string} char */
function inputsRevision(char) {
  return char.repeat(INPUTS_LENGTH);
}

const HEAD = sha("c");
const MOVED = sha("f");
const MERGE_COMMIT = sha("e");
const INPUTS = inputsRevision("a");
const NEW_INPUTS = inputsRevision("9");
const GHERKIN_TEXT =
  "Feature: Chats\n  Scenario: list\n    Given a chat\n    Then it is listed";

/** @type {import("../src/state.ts").Revision} */
const REVISION = { code: HEAD, wiki: null, inputs: INPUTS };

/**
 * @typedef {import("./reviewer-and-merge-role-calls-kit.mjs").Call} Call
 * @typedef {import("../src/job/role-context.ts").RoleContext} RoleContext
 */

/**
 * The current-revision op's reply.
 * @param {Partial<import("../src/state.ts").Revision>} [revision]
 * @param {{ number: number, state: string, mergeCommit: string | null, headSha: string } | null} [pr]
 */
function current(
  revision = {},
  pr = { number: PR, state: "OPEN", mergeCommit: null, headSha: HEAD },
) {
  return { revision: { ...REVISION, ...revision }, baseSha: sha("b"), pr };
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
    flows: { code: true, wiki: false },
    ...state,
  };
}

/** @param {Partial<import("../src/state.ts").IssueState["review"]>} [review] */
function approvedReview(review = {}) {
  return {
    round: 0,
    verdict: /** @type {const} */ ("approve"),
    commentId: APPROVAL_COMMENT_ID,
    findings: [],
    revision: REVISION,
    ...review,
  };
}

/** @param {Partial<import("../src/gherkin-comment.ts").GherkinComment>} [gherkin] */
function gherkinComment(gherkin = {}) {
  return {
    id: GHERKIN_COMMENT_ID,
    rev: GHERKIN_REV,
    inputs: INPUTS,
    gherkin: GHERKIN_TEXT,
    assumptions: ["the list is newest first"],
    wikiPages: ["Chats"],
    ...gherkin,
  };
}

/**
 * Op replies in turn: a value, or a function of the payload. An op with no
 * reply left fails the test, so an unexpected op, a mutation above all,
 * never passes unseen.
 * @param {Record<string, unknown[]>} script @param {Call[]} calls
 * @returns {RoleContext["op"]}
 */
function scriptedOps(script, calls) {
  /** @type {Map<string, unknown[]>} */
  const ops = new Map(
    Object.entries(script).map(([name, replies]) => [name, [...replies]]),
  );
  return (name, payload) => {
    calls.push({ kind: "op", name, payload });
    const replies = ops.get(name) ?? [];
    if (replies.length === 0) {
      return Promise.reject(new Error(`unexpected op ${name}`));
    }
    const reply = replies.shift();
    if (typeof reply === "function") {
      return Promise.resolve().then(() => reply(payload));
    }
    return Promise.resolve(reply);
  };
}

/**
 * Session results in turn; a session with none left fails the test.
 * @param {import("../src/job/role-context.ts").SessionResult[]} script
 * @param {Call[]} calls
 * @returns {RoleContext["session"]}
 */
function scriptedSessions(script, calls) {
  const sessions = [...script];
  return (spec) => {
    calls.push({ kind: "session", spec });
    const result = sessions.shift();
    if (result === undefined) {
      return Promise.reject(new Error("unexpected session"));
    }
    return Promise.resolve(result);
  };
}

/**
 * The job's Gherkin: the script's, which may be null, or the default
 * comment when the script names none.
 * @param {import("../src/gherkin-comment.ts").GherkinComment | null | undefined} gherkin
 */
function gherkinOf(gherkin) {
  if (gherkin === undefined) {
    return gherkinComment();
  }
  return gherkin;
}

/**
 * A fake RoleContext, with the runtime's `mergeQueue`, logging every call.
 * @param {{
 *   stage: import("../src/stages.ts").Stage,
 *   state: import("../src/state.ts").IssueState,
 *   ops?: Record<string, unknown[]>,
 *   sessions?: import("../src/job/role-context.ts").SessionResult[],
 *   gherkin?: import("../src/gherkin-comment.ts").GherkinComment | null | undefined,
 *   mergeQueue?: readonly number[] | null,
 *   config?: Partial<import("../src/config.ts").Config> | undefined,
 * }} script
 */
function fakeContext(script) {
  /** @type {Call[]} */
  const calls = [];
  /** @type {RoleContext & { mergeQueue: readonly number[] | null }} */
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
      gherkin: gherkinOf(script.gherkin),
    },
    mergeQueue: script.mergeQueue ?? null,
    op: scriptedOps(script.ops ?? {}, calls),
    session: scriptedSessions(script.sessions ?? [], calls),
    post: (comment) => {
      calls.push({ kind: "post", comment });
      return Promise.resolve(COMMENT_ID);
    },
    save: (state) => {
      calls.push({ kind: "save", state });
      return Promise.resolve();
    },
  };
  return { ctx, calls };
}

export {
  approvedReview,
  COMMENT_ID,
  cfg,
  current,
  fakeContext,
  GHERKIN_TEXT,
  gherkinComment,
  HEAD,
  INPUTS,
  issueState,
  LIMITS,
  MERGE_COMMIT,
  MOVED,
  mergeRole,
  NEW_INPUTS,
  PR,
  REVISION,
  reviewerRole,
  SHORT_SHA_LENGTH,
  sha,
};
