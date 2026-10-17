// @ts-check
// Fixtures for driving the finishing stages' step machines (accept, security
// and merge) directly: a context with a fixed clock, issue #7's verified
// state, the sessions' signature, and helpers that feed a machine its
// recorded results.
import { preamble } from "../src/workflow/prompts.ts";
import { hasRoom, modelsWith } from "./workflow-context-test-kit.mjs";

/** @import { Signature } from "../src/workflow/signing.ts" */
/** @import { OpResult, StageContext, StageMachine, StageState, Step } from "../src/workflow/stages/types.ts" */
/** @import { IssueState, ItemPaths } from "../src/workflow/types.ts" */
/** @import { Ended } from "./workflow-context-test-kit.mjs" */

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
  maxContinuations: 1,
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
  verifier: "anthropic/claude-sonnet-5-5",
  security: "anthropic/claude-opus-5-5",
};
const VERIFIED = "feedfacefeedfacefeedfacefeedfacefeedface";
// The verified head as a comment names it.
const SHORT_SHA = "feedfacefeed";
const DIFF = {
  ok: true,
  headSha: VERIFIED,
  diffPath: "/d.diff",
  diffLines: 12,
};
/** @type {Signature} */
const SIGNATURE = {
  role: "accept",
  agent: "issue-pipeline-reader",
  model: "claude-sonnet-5-5",
  run: "i7-accept-4",
};

/** @returns {StageContext} */
function contextWith() {
  return {
    cfg: CFG,
    budgets: {
      roles: ROLES,
      sessionCap: 150_000,
      softLimit: 175_000,
      hardLimit: 225_000,
    },
    models: modelsWith(MODELS),
    now: () => NOW,
    hasRoom,
    mergeQueue: null,
  };
}

const CTX = contextWith();

// Issue #7, verified and at `stage`'s first call, with `fields` replacing its
// saved state's and `item` the stage state's.
/**
 * @param {string} stage @param {Partial<IssueState>} [fields]
 * @param {Partial<StageState>} [item]
 * @returns {StageState}
 */
function stateWith(stage, fields = {}, item = {}) {
  return {
    n: 7,
    paths: PATHS,
    st: {
      stage,
      depth: 0,
      pr: 42,
      headSha: VERIFIED,
      verifiedSha: VERIFIED,
      verifySummary: "test: ok",
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
    ...item,
  };
}

// The step after `step`'s one ops request gets `reply`.
/** @param {StageMachine["next"]} next @param {Step} step @param {OpResult["reply"]} reply @returns {Step} */
function replied(next, step, reply) {
  return next(step.state, CTX, [{ kind: "op", reply }]);
}

// The step after `step`'s one session ends with `result`.
/** @param {StageMachine["next"]} next @param {Step} step @param {Ended} result @returns {Step} */
function sessionEnded(next, step, result) {
  return next(step.state, CTX, [
    { kind: "child", error: null, by: SIGNATURE, ...result },
  ]);
}

// The step after the stage prepared its diff with `diff`.
/** @param {StageMachine["next"]} next @param {StageState} given @param {OpResult["reply"]} [diff] @returns {Step} */
function prepared(next, given, diff = DIFF) {
  return replied(next, next(given, CTX, []), diff);
}

// The step after the stage's session replied with `output`.
/** @param {StageMachine["next"]} next @param {StageState} given @param {unknown} output @returns {Step} */
function decided(next, given, output) {
  const step = prepared(next, given);
  return sessionEnded(next, step, { ok: true, structuredOutput: output });
}

// A child's whole task: the preamble for `role`, then `lines`.
/** @param {string} role @param {readonly string[]} lines @returns {string} */
function taskOf(role, lines) {
  return preamble(CFG, { n: 7, paths: PATHS }, role).concat(lines).join("\n");
}

export {
  CTX,
  contextWith,
  DIFF,
  decided,
  MODELS,
  prepared,
  ROLES,
  replied,
  SHORT_SHA,
  SIGNATURE,
  STAMP,
  sessionEnded,
  stateWith,
  taskOf,
  VERIFIED,
};
