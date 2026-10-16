// @ts-check
// Fixtures for the workflow stage scenarios run through workflow-harness.mjs:
// the run's args, the ops replies every scenario needs, and builders for the
// sweep and claim replies and for the summary the workflow returns.

/** @import { TraceEntry } from "./workflow-harness.mjs" */
/** @import { IssueState, ItemPaths } from "../src/workflow/types.ts" */

// The run's args. The workflow reads its settings from the sweep reply.
const WORKFLOW_ARGS = { config: "/w/repos/o__r.json", lane: "lane-a" };

// The issue the scenarios work on, unless they name another.
const ISSUE = 7;

// The sweep id the workflow derives from the harness's fixed clock.
const SWEEP_ID = "smv9hl6o0";

// The repo config the sweep reply carries (ops.mjs's publicConfig).
const DEFAULT_CONFIG = {
  repo: "o/r",
  baseBranch: "integration",
  sessionTokenCap: 150_000,
  issueTokenBudget: 1_000_000,
  rebaseTokenBudget: 500_000,
  maxTriages: 2,
  maxFixRounds: 2,
  maxCiFixes: 1,
  maxSyncs: 3,
  ciWaitMinutes: 30,
  practices: ["AGENTS.md", "CONTRIBUTING.md"],
  commands: { test: "npm test", lint: "npm run lint" },
};

// Replies for the ops whose answer the workflow only checks for `ok`.
const ROUTINE_OPS = {
  "save-state": { ok: true },
  stop: { ok: true },
  release: { ok: true },
  post: { ok: true },
  cleanup: { ok: true, worktrees: [] },
};

// The sweep reply: candidate issue numbers, parents to close, and config
// fields that replace the defaults (such as `maxSpawnsPerRun`).
/** @param {{ items?: number[], parents?: unknown[], config?: object }} [reply] @returns {{ ok: true, config: Record<string, unknown>, items: { number: number, depth: number }[], waiting: number, parents: unknown[], liveElsewhere: number, skipped: number }} */
function sweepReply({ items = [], parents = [], config = {} } = {}) {
  return {
    ok: true,
    config: { ...DEFAULT_CONFIG, ...config },
    items: items.map((number) => ({ number, depth: 0 })),
    waiting: 0,
    parents,
    liveElsewhere: 0,
    skipped: 0,
  };
}

// A won claim of an issue saved at `stage`. The state copies ops.mjs's
// newState, which can't be imported because ops.mjs runs as a CLI; `fields`
// replace its fields (`number` defaults to ISSUE). The paths are the ones
// ops' claim gives.
/** @param {string} stage @param {object} [fields] @returns {{ ok: true, state: IssueState, paths: ItemPaths }} */
function claimAt(stage, fields = {}) {
  const state = {
    version: 1,
    number: ISSUE,
    depth: 0,
    stage,
    lease: null,
    pr: null,
    headSha: null,
    reviewedSha: null,
    verifiedSha: null,
    plan: null,
    allocated: 0,
    reportedTokens: 0,
    sessions: [],
    triages: 0,
    continuations: 0,
    round: 0,
    ciFixes: 0,
    syncs: 0,
    findings: [],
    resolvedHistory: [],
    questionsAt: null,
    log: [],
    ...fields,
  };
  const worktree = `/w/work/o__r/issue-${state.number}`;
  return {
    ok: true,
    state,
    paths: {
      worktree,
      issueFile: `/w/runs/o__r/issue-${state.number}/issue.md`,
      wiki: `${worktree}/wiki`,
      handoffFile: `/w/runs/o__r/issue-${state.number}/handoff.md`,
    },
  };
}

// An agent's reply with its structured output.
/** @param {unknown} structuredOutput @returns {object} */
function replyWith(structuredOutput) {
  return { ok: true, structuredOutput };
}

// The summary the workflow returns, with `fields` replacing the empty sweep's.
/** @param {object} [fields] @returns {object} */
function sweepSummary(fields = {}) {
  return {
    sweep: SWEEP_ID,
    lane: WORKFLOW_ARGS.lane,
    repo: DEFAULT_CONFIG.repo,
    waiting: 0,
    abandoned: [],
    items: [],
    parentsClosed: 0,
    cleanup: { worktrees: [], error: null },
    ...fields,
  };
}

// The launch keys of a trace, in order.
/** @param {readonly TraceEntry[]} trace @returns {string[]} */
function launchKeys(trace) {
  return trace.map(({ key }) => key);
}

export {
  claimAt,
  ISSUE,
  launchKeys,
  ROUTINE_OPS,
  replyWith,
  sweepReply,
  sweepSummary,
  WORKFLOW_ARGS,
};
