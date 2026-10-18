// @ts-check
// A fake RoleContext for the implementor role's tests. Its ops and sessions
// answer from scripts and record every call; nothing runs git, gh or a model.
//
// Importing this kit first points HOME and ISSUE_PIPELINE_ROOT at a fresh
// temporary folder, since the pipeline's modules read the root once, on
// import. A test then imports the pipeline's modules dynamically, after this
// kit, and checks with `assertTemporaryRoot` that the root they read is that
// folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const place = fs.mkdtempSync(path.join(os.tmpdir(), "implementor-kit-"));
process.on("exit", () => fs.rmSync(place, { recursive: true, force: true }));
process.env["HOME"] = place;
process.env["ISSUE_PIPELINE_ROOT"] = path.join(place, "root");

const { ROOT } = await import("../src/pipeline-root.ts");
const { testConfig } = await import("./config-test-kit.mjs");
const { newIssueState } = await import("../src/state.ts");
const { OpsFailure } = await import("../src/job/role-context.ts");

/** @typedef {import("../src/job/role-context.ts").RoleContext} RoleContext */
/** @typedef {import("../src/job/role-context.ts").SessionSpec} SessionSpec */
/** @typedef {import("../src/job/role-context.ts").SessionResult} SessionResult */
/** @typedef {import("../src/job/role-context.ts").OpName} OpName */
/** @typedef {import("../src/state.ts").IssueState} IssueState */
/** @typedef {import("../src/gherkin-comment.ts").GherkinComment} GherkinComment */
/** @typedef {{ name: OpName, payload: Record<string, unknown> }} OpCall */
/**
 * An op's scripted replies, used in order, the last one again once they run
 * out; a reply that is an Error is thrown as the op's failure.
 * @typedef {Partial<Record<OpName, unknown[]>>} OpScript
 */

const ISSUE = 7;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const INPUTS = "c".repeat(64);

/** @type {GherkinComment} */
const GHERKIN = {
  id: 41,
  rev: 2,
  inputs: INPUTS,
  gherkin:
    "Feature: Chats\n  Scenario: list\n    Given a chat\n    Then it is listed",
  assumptions: ["Chats are sorted newest first"],
  wikiPages: ["Chats"],
};

// The ops of a clean run: no conflicts, every check passing, code pushed.
/** @type {OpScript} */
const CLEAN_OPS = {
  "start-pr": [{ pr: 12, headSha: HEAD }],
  "sync-base": [{ changed: false, conflict: false, headSha: HEAD }],
  "wiki-sync": [{ changed: false, conflict: false, headSha: "" }],
  verify: [{ pass: true, headSha: HEAD, changedFiles: ["a.ts"], checks: [] }],
  "wiki-check": [{ pass: true, checks: [] }],
  "open-pr": [{ pr: 12, headSha: HEAD, codeChanged: true, wikiAhead: 1 }],
  push: [{ headSha: HEAD, codeChanged: true, wikiAhead: 1 }],
  "finish-sync": [{ resolved: true, headSha: HEAD }],
  "finish-wiki-sync": [{ resolved: true, headSha: "d".repeat(40) }],
  "close-pr": [{ pr: 12, closed: true }],
};

const DONE = { ok: true, reply: { outcome: "done", summary: "Lists chats" } };

/**
 * @param {Record<string, unknown>} [extra] config keys over the test config
 */
function configOf(extra = {}) {
  return testConfig({ maxCiFixes: 2, maxConflictFixes: 2, ...extra }).cfg;
}

/**
 * @param {{
 *   ops?: OpScript,
 *   sessions?: SessionResult[],
 *   state?: Partial<IssueState>,
 *   gherkin?: GherkinComment | null,
 *   docs?: string | null,
 *   config?: Record<string, unknown>,
 * }} [script]
 */
function fakeContext(script = {}) {
  /** @type {OpCall[]} */
  const ops = [];
  /** @type {SessionSpec[]} */
  const sessions = [];
  /** @type {IssueState[]} */
  const saves = [];
  /** @type {OpScript} */
  const replies = { ...CLEAN_OPS, ...script.ops };
  /** @type {Partial<Record<OpName, number>>} */
  const used = {};
  const results = script.sessions ?? [DONE];
  /** @type {RoleContext} */
  const ctx = {
    cfg: configOf(script.config),
    issue: ISSUE,
    stage: "implement",
    state: { ...newIssueState(ISSUE), stage: "implement", ...script.state },
    dirs: {
      job: "/job",
      repo: "/job/repo",
      docs: script.docs === undefined ? "/job/docs" : script.docs,
    },
    issueFile: "/job/issue.md",
    inputs: {
      issue: { title: "List chats", body: "B", user: { login: "owner" } },
      comments: [],
      revision: INPUTS,
      gherkin: script.gherkin === undefined ? GHERKIN : script.gherkin,
    },
    op: (name, payload) => {
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
    },
    session: (spec) => {
      sessions.push(spec);
      const result = results[Math.min(sessions.length - 1, results.length - 1)];
      assert.ok(result !== undefined, "a scripted session result");
      return Promise.resolve(result);
    },
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

function assertTemporaryRoot() {
  assert.equal(ROOT, path.join(place, "root"));
  assert.ok(ROOT.startsWith(os.tmpdir()), `${ROOT} is not temporary`);
}

export {
  assertTemporaryRoot,
  BASE,
  CLEAN_OPS,
  DONE,
  fakeContext,
  GHERKIN,
  HEAD,
  INPUTS,
  ISSUE,
  opNames,
  place,
};
