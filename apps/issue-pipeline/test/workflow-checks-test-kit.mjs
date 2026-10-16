// @ts-check
// Fixtures for driving the sync and checks step machines directly: a context
// with a fixed clock, issue #7's state at a stage, and builders for the
// results a step's launches return.
import { byStep } from "../src/workflow/signing.ts";
import { hasRoom, modelsWith } from "./workflow-context-test-kit.mjs";

/** @import { Signature } from "../src/workflow/signing.ts" */
/** @import { ChildResult, LaunchResult, OpResult, StageComment, StageContext, StageMachine, StageState, Step } from "../src/workflow/stages/types.ts" */
/** @import { IssueState, ItemPaths } from "../src/workflow/types.ts" */

const NOW = new Date("2026-10-15T12:00:30Z");
const STAMP = "2026-10-15T12:00Z";
/** @type {ItemPaths} */
const PATHS = {
  worktree: "/w/issue-7",
  issueFile: "/runs/issue.md",
  wiki: null,
  handoffFile: "/runs/issue-7/handoff.md",
};
/** @type {StageContext["cfg"]} */
const CFG = {
  repo: "o/r",
  baseBranch: "integration",
  maxTriages: 2,
  maxFixRounds: 2,
  maxSyncs: 3,
  maxCiFixes: 1,
  ciWaitMinutes: 30,
  practices: ["AGENTS.md"],
  commands: {},
};
const ROLES = {
  triage: 50_000,
  spec: 80_000,
  implementer: 150_000,
  reviewer: 60_000,
  aggregator: 20_000,
  fixer: 100_000,
  rereviewer: 40_000,
  ciFixer: 100_000,
  verifier: 60_000,
};
const MODELS = {
  fixer: "anthropic/claude-opus-5-5",
  correctness: "anthropic/claude-opus-5-5",
  scope: "anthropic/claude-sonnet-5-5",
};
const ISSUE_BUDGET = 1_000_000;

// A context with a fixed clock, with `fields` replacing its defaults.
// Every kit's rebase pool (`rebaseTokenBudget`).
const REBASE_BUDGET = 500_000;

/** @param {Partial<StageContext>} [fields] @returns {StageContext} */
function contextWith(fields = {}) {
  return {
    cfg: CFG,
    budgets: {
      roles: ROLES,
      sessionCap: 150_000,
      issueBudget: ISSUE_BUDGET,
      rebaseBudget: REBASE_BUDGET,
    },
    models: modelsWith(MODELS),
    now: () => NOW,
    hasRoom,
    mergeQueue: null,
    ...fields,
  };
}

const CTX = contextWith();

// Issue #7 at `stage`'s first call, with `fields` replacing its saved
// state's.
/** @param {string} stage @param {Partial<IssueState>} [fields] @returns {StageState} */
function stateAt(stage, fields = {}) {
  return {
    n: 7,
    paths: PATHS,
    st: {
      stage,
      depth: 0,
      pr: 42,
      headSha: "cccccccccccccccc",
      reviewedSha: "cccccccccccccccc",
      verifiedSha: null,
      allocated: 0,
      sessions: [],
      ciFixes: 0,
      syncs: 0,
      findings: [],
      log: [],
      ...fields,
    },
    closed: false,
    outcome: null,
    held: false,
    rebasedOnly: false,
    resynced: false,
    phase: "begin",
    carry: null,
  };
}

// The signature the sweep gives a session launched as `name`.
/** @param {string} name @returns {Signature} */
function signedAs(name) {
  return {
    role: name,
    agent: "issue-pipeline-writer",
    model: "claude-opus-5-5",
    run: `i7-${name}-5`,
  };
}

// A session's result, signed as its launch `name`.
/** @param {string} name @param {unknown} structuredOutput @returns {ChildResult} */
function sessionResult(name, structuredOutput) {
  return {
    kind: "child",
    ok: true,
    structuredOutput,
    error: null,
    by: signedAs(name),
  };
}

// The step after `step`'s launches return `results`, by `next`.
/**
 * @param {StageMachine["next"]} next @param {Step} step @param {StageContext} ctx
 * @param {...LaunchResult} results
 * @returns {Step}
 */
function after(next, step, ctx, ...results) {
  return next(step.state, ctx, results);
}

// The step after `step`'s one ops request gets `reply`.
/**
 * @param {StageMachine["next"]} next @param {Step} step
 * @param {OpResult["reply"]} reply @param {StageContext} [ctx]
 * @returns {Step}
 */
function replied(next, step, reply, ctx = CTX) {
  return after(next, step, ctx, { kind: "op", reply });
}

// A comment a deterministic step posts on the PR.
/** @param {string} role @param {string} body @returns {StageComment} */
function stepComment(role, body) {
  return { by: byStep(role), body, where: "pr" };
}

export {
  after,
  CTX,
  contextWith,
  MODELS,
  PATHS,
  replied,
  STAMP,
  sessionResult,
  signedAs,
  stateAt,
  stepComment,
};
