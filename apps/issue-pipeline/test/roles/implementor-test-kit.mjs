// @ts-check
// A fake RoleContext for the implementor role's tests. Its ops and sessions
// answer from scripts and record every call; nothing runs git, gh or a model.
//
// Importing this kit first points HOME and ISSUE_PIPELINE_ROOT at a fresh
// temporary folder, since the pipeline's modules read the root once, on
// import. A test then imports the pipeline's modules dynamically, after this
// kit, and checks that the root they read, `ROOT`, is `TEMPORARY_ROOT`.
import { isolatedRoot } from "../isolated-root-test-kit.mjs";

const TEMPORARY_ROOT = isolatedRoot;
const { ROOT } = await import("../../src/pipeline-root.ts");
const { testConfig } = await import("../config-test-kit.mjs");
const { newIssueState } = await import("../../src/state.ts");
const { OpsFailure } = await import("../../src/job/role-context.ts");

/** @typedef {import("../../src/job/role-context.ts").RoleContext} RoleContext */
/** @typedef {import("../../src/job/role-context.ts").SessionSpec} SessionSpec */
/** @typedef {import("../../src/job/role-context.ts").SessionResult} SessionResult */
/** @typedef {import("../../src/job/role-context.ts").OpName} OpName */
/** @typedef {import("../../src/state.ts").IssueState} IssueState */
/** @typedef {import("../../src/gherkin-comment.ts").GherkinComment} GherkinComment */
/** @typedef {{ name: OpName, payload: Record<string, unknown> }} OpCall */
/**
 * An op's scripted replies, used in order, the last one again once they run
 * out; a reply that is an Error is thrown as the op's failure.
 * @typedef {Partial<Record<OpName, unknown[]>>} OpScript
 */

const ISSUE = 7;
const PR = 12;
const SHA_LENGTH = 40;
const INPUTS_LENGTH = 64;

/** A full commit sha of one repeated hex digit. @param {string} digit */
function shaOf(digit) {
  return digit.repeat(SHA_LENGTH);
}

const HEAD = shaOf("a");
const BASE = shaOf("b");
const INPUTS = "c".repeat(INPUTS_LENGTH);

/** @type {GherkinComment} */
const GHERKIN = {
  id: 41,
  rev: 2,
  inputs: INPUTS,
  gherkin:
    "Feature: Chats\n  Scenario: list\n    Given a chat\n    Then it is listed",
  assumptions: ["Chats are sorted newest first"],
};

// The ops of a clean run: no conflicts, every check passing, code pushed.
/** @type {OpScript} */
const CLEAN_OPS = {
  "start-pr": [{ pr: PR, headSha: HEAD }],
  "sync-base": [{ changed: false, conflict: false, headSha: HEAD }],
  verify: [{ pass: true, headSha: HEAD, changedFiles: ["a.ts"], checks: [] }],
  "open-pr": [{ pr: PR, headSha: HEAD, codeChanged: true }],
  push: [{ headSha: HEAD, codeChanged: true }],
  "finish-sync": [{ resolved: true, headSha: HEAD }],
};

/** @type {SessionResult} */
const DONE = { ok: true, reply: { outcome: "done", summary: "Lists chats" } };

/**
 * @param {Record<string, unknown>} [extra] config keys over the test config
 */
function configOf(extra = {}) {
  return testConfig({ maxCiFixes: 2, maxConflictFixes: 2, ...extra }).cfg;
}

/**
 * The fake `op`, answering from `script` over the clean run's replies, and
 * the calls it records.
 * @param {OpScript} [script]
 */
function scriptedOps(script = {}) {
  /** @type {OpCall[]} */
  const ops = [];
  /** @type {OpScript} */
  const replies = { ...CLEAN_OPS, ...script };
  /** @type {Partial<Record<OpName, number>>} */
  const used = {};
  /**
   * @param {OpName} name
   * @param {object} payload
   * @returns {Promise<unknown>}
   */
  function op(name, payload) {
    ops.push({ name, payload: { ...payload } });
    const list = replies[name];
    if (list === undefined || list.length === 0) {
      return Promise.reject(new OpsFailure(name, 1, `unscripted op ${name}`));
    }
    const at = used[name] ?? 0;
    used[name] = at + 1;
    const reply = list[Math.min(at, list.length - 1)];
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(reply);
  }
  return { op, ops };
}

/**
 * The fake `session`, answering `results` in order and the last one again
 * once they run out, and the specs it records.
 * @param {SessionResult[]} results
 */
function scriptedSessions(results) {
  /** @type {SessionSpec[]} */
  const sessions = [];
  /**
   * @param {SessionSpec} spec
   * @returns {Promise<SessionResult>}
   */
  function session(spec) {
    sessions.push(spec);
    const result = results[Math.min(sessions.length - 1, results.length - 1)];
    if (result === undefined) {
      return Promise.reject(new Error("no scripted session result"));
    }
    return Promise.resolve(result);
  }
  return { session, sessions };
}

/**
 * @param {{
 *   ops?: OpScript,
 *   sessions?: SessionResult[],
 *   state?: Partial<IssueState>,
 *   gherkin?: GherkinComment | null,
 *   config?: Record<string, unknown>,
 * }} [script]
 */
function fakeContext(script = {}) {
  const { op, ops } = scriptedOps(script.ops);
  const { session, sessions } = scriptedSessions(script.sessions ?? [DONE]);
  /** @type {IssueState[]} */
  const saves = [];
  // A null Gherkin is the test's own; only a missing one defaults.
  const { gherkin = GHERKIN } = script;
  /** @type {RoleContext} */
  const ctx = {
    cfg: configOf(script.config),
    issue: ISSUE,
    stage: "implement",
    mergeQueue: null,
    state: {
      ...newIssueState(ISSUE, "author"),
      stage: "implement",
      ...script.state,
    },
    dirs: { job: "/job", repo: "/job/repo" },
    issueFile: "/job/issue.md",
    inputs: {
      issue: { title: "List chats", body: "B", user: { login: "owner" } },
      comments: [],
      revision: INPUTS,
      gherkin,
    },
    op,
    session,
    post: () => Promise.reject(new Error("the implementor posts no comment")),
    save: (state) => {
      saves.push(state);
      return Promise.resolve();
    },
  };
  return { ctx, ops, sessions, saves };
}

/** @param {OpCall[]} ops */
function opNames(ops) {
  return ops.map((call) => call.name);
}

export {
  BASE,
  CLEAN_OPS,
  DONE,
  fakeContext,
  GHERKIN,
  HEAD,
  INPUTS,
  ISSUE,
  opNames,
  PR,
  ROOT,
  shaOf,
  TEMPORARY_ROOT,
};
