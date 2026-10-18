// @ts-check
// A default-deny RoleContext; only explicitly scripted ops and sessions run.
// The imported fixture already isolated HOME/ROOT and blocked real gh/pi.
import { INPUTS, ISSUE, PR } from "./explicit-target-world-test-kit.mjs";

/** @typedef {import("../src/job/role-context.ts").RoleContext} RoleContext */
/** @typedef {{ kind: "op", name: string, payload: object } | { kind: "session", spec: import("../src/job/role-context.ts").SessionSpec } | {kind: "save", state: import("../src/state.ts").IssueState} | {kind: "post"}} Call */

/**
 * @param {Record<string, unknown[]>} script
 * @param {Call[]} calls
 * @returns {RoleContext["op"]}
 */
function scriptedOps(script, calls) {
  const replies = new Map(
    Object.entries(script).map(([name, values]) => [name, [...values]]),
  );
  return async (name, payload) => {
    calls.push({ kind: "op", name, payload });
    const values = replies.get(name) ?? [];
    if (values.length === 0) {
      throw new Error(`unexpected op ${name}`);
    }
    const reply = values.shift();
    if (reply instanceof Error) {
      throw reply;
    }
    return await Promise.resolve(reply);
  };
}

/**
 * @param {import("./explicit-target-world-test-kit.mjs").World} w
 * @param {{state?: Partial<import("../src/state.ts").IssueState>, ops: Record<string, unknown[]>, sessions?: import("../src/job/role-context.ts").SessionResult[]}} script
 */
function context(w, script) {
  /** @type {Call[]} */
  const calls = [];
  const sessions = [...(script.sessions ?? [])];
  /** @type {RoleContext} */
  const ctx = {
    cfg: w.cfg,
    issue: ISSUE,
    stage: "merge",
    mergeQueue: null,
    state: { ...w.state, ...script.state },
    dirs: { job: w.place, repo: w.wt, docs: null },
    issueFile: "issue.md",
    inputs: {
      issue: { title: "Target", body: "Deliver", user: { login: "owner" } },
      comments: [],
      revision: INPUTS,
      gherkin: {
        id: 41,
        rev: 1,
        inputs: INPUTS,
        gherkin: "Feature: delivery\n  Scenario: exact result",
        assumptions: [],
        wikiPages: [],
      },
    },
    op: scriptedOps(script.ops, calls),
    session: async (spec) => {
      calls.push({ kind: "session", spec });
      const reply = sessions.shift();
      if (reply === undefined) {
        throw new Error("unexpected model session");
      }
      return await Promise.resolve(reply);
    },
    save: async (state) => {
      calls.push({ kind: "save", state });
      await Promise.resolve();
    },
    post: async () => {
      calls.push({ kind: "post" });
      return await Promise.resolve(PR);
    },
  };
  return { ctx, calls };
}
/** @param {import("./explicit-target-world-test-kit.mjs").World} w @param {boolean} [merged] */
function current(w, merged = false) {
  let code = w.head;
  let state = "OPEN";
  let mergeCommit = null;
  if (merged) {
    code = w.merged;
    state = "MERGED";
    mergeCommit = w.merged;
  }
  return {
    revision: { ...w.revision, code },
    baseSha: w.base,
    pr: { number: PR, state, mergeCommit, headSha: w.head },
  };
}
/** @param {Call[]} calls @returns {string[]} */
function names(calls) {
  return calls.map((call) => {
    if (call.kind === "op") {
      return call.name;
    }
    return call.kind;
  });
}
/** @param {Call[]} calls @returns {import("../src/state.ts").IssueState[]} */
function saves(calls) {
  return calls.flatMap((call) => {
    if (call.kind === "save") {
      return [call.state];
    }
    return [];
  });
}

/** @type {{pass: boolean, checks: import("../src/ops/checks.ts").Check[]}} */
const WIKI_PASS = { pass: true, checks: [] };
/** @type {import("../src/job/role-context.ts").SessionResult} */
const NO_FINDING = {
  ok: true,
  reply: { summary: "No security finding", security: null },
};
const NO_WRITES = ["push", "sync-base", "wiki-sync", "ready-pr"];

/** @param {import("./explicit-target-world-test-kit.mjs").World} w @returns {import("../src/ops/checks.ts").VerifyReply} */
function verified(w) {
  return { pass: true, headSha: w.merged, checks: [] };
}
/** @param {import("./explicit-target-world-test-kit.mjs").World} w */
function result(w) {
  return { ...w.revision, code: w.merged };
}
/** @param {import("./explicit-target-world-test-kit.mjs").World} w */
function ownState(w) {
  return { merged: result(w), codeMerged: { pr: PR, sha: w.merged } };
}
/** @param {import("./explicit-target-world-test-kit.mjs").World} w */
function postmergeOps(w) {
  return {
    verify: [verified(w)],
    "wiki-check": [WIKI_PASS],
    "prepare-review": [
      {
        headSha: w.merged,
        diffPath: "diff",
        bundlePath: "bundle",
        changedFiles: ["early.txt", "late.txt"],
      },
    ],
    "finish-wiki": [{ finished: true, closed: true }],
  };
}
/** @param {import("./explicit-target-role-test-kit.mjs").Call[]} calls */
function codeWrites(calls) {
  return names(calls).filter((name) => NO_WRITES.includes(name));
}

export {
  codeWrites,
  context,
  current,
  NO_FINDING,
  names,
  ownState,
  postmergeOps,
  result,
  saves,
  verified,
  WIKI_PASS,
};
