// Fixtures for driving the sync and checks step machines directly: a context
// with a fixed clock, issue #7's state at a stage, and builders for the
// results a step's launches return.
import { byStep } from "../src/workflow/signing.ts";

const NOW = new Date("2026-10-15T12:00:30Z");
const STAMP = "2026-10-15T12:00Z";
const PATHS = {
  worktree: "/w/issue-7",
  issueFile: "/runs/issue.md",
  wiki: null,
};
const CFG = {
  repo: "o/r",
  baseBranch: "integration",
  maxTriages: 2,
  maxSyncs: 3,
  maxCiFixes: 1,
  ciWaitMinutes: 30,
  practices: ["AGENTS.md"],
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

function contextWith(fields = {}) {
  return {
    cfg: CFG,
    budgets: {
      roles: ROLES,
      sessionCap: 150_000,
      issueBudget: ISSUE_BUDGET,
      rebaseBudget: REBASE_BUDGET,
    },
    models: MODELS,
    now: () => NOW,
    hasRoom: () => true,
    ...fields,
  };
}

const CTX = contextWith();

// Issue #7 at `stage`'s first call, with `fields` replacing its saved
// state's.
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
function signedAs(name) {
  return {
    role: name,
    agent: "issue-pipeline-writer",
    model: "claude-opus-5-5",
    run: `i7-${name}-5`,
  };
}

// A session's result, signed as its launch `name`.
function sessionResult(name, structuredOutput) {
  return {
    kind: "child",
    ok: true,
    structuredOutput,
    error: null,
    by: signedAs(name),
  };
}

function failedSession(name, error) {
  return {
    kind: "child",
    ok: false,
    structuredOutput: null,
    error,
    by: signedAs(name),
  };
}

// The step after `step`'s launches return `results`, by `next`.
function after(next, step, ctx, ...results) {
  return next(step.state, ctx, results);
}

// The step after `step`'s one ops request gets `reply`.
function replied(next, step, reply, ctx = CTX) {
  return after(next, step, ctx, { kind: "op", reply });
}

// A comment a deterministic step posts on the PR.
function stepComment(role, body) {
  return { by: byStep(role), body, where: "pr" };
}

export {
  after,
  CTX,
  contextWith,
  failedSession,
  MODELS,
  PATHS,
  ROLES,
  replied,
  STAMP,
  sessionResult,
  signedAs,
  stateAt,
  stepComment,
};
