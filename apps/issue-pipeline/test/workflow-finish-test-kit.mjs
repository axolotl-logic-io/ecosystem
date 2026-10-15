// Fixtures for driving the finishing stages' step machines (accept, security
// and merge) directly: a context with a fixed clock, issue #7's verified
// state, the sessions' signature, and helpers that feed a machine its
// recorded results.
import { preamble } from "../src/workflow/prompts.ts";

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
  maxFixRounds: 2,
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
const ISSUE_BUDGET = 1_000_000;
const DIFF = {
  ok: true,
  headSha: VERIFIED,
  diffPath: "/d.diff",
  diffLines: 12,
};
const SIGNATURE = {
  role: "accept",
  agent: "issue-pipeline-reader",
  model: "claude-sonnet-5-5",
  run: "i7-accept-4",
};

// Every kit's rebase pool (`rebaseTokenBudget`).
const REBASE_BUDGET = 500_000;

function contextWith(issueBudget) {
  return {
    cfg: CFG,
    budgets: {
      roles: ROLES,
      sessionCap: 150_000,
      issueBudget,
      rebaseBudget: REBASE_BUDGET,
    },
    models: MODELS,
    now: () => NOW,
  };
}

const CTX = contextWith(ISSUE_BUDGET);

// Issue #7, verified and at `stage`'s first call, with `fields` replacing its
// saved state's and `item` the stage state's.
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
      allocated: 0,
      sessions: [],
      findings: [],
      log: [],
      ...fields,
    },
    closed: false,
    outcome: null,
    rebasedOnly: false,
    resynced: false,
    phase: "begin",
    ...item,
  };
}

// The step after `step`'s one ops request gets `reply`.
function replied(next, step, reply) {
  return next(step.state, CTX, [{ kind: "op", reply }]);
}

// The step after `step`'s one session ends with `result`.
function sessionEnded(next, step, result) {
  return next(step.state, CTX, [
    { kind: "child", error: null, by: SIGNATURE, ...result },
  ]);
}

// The step after the stage prepared its diff with `diff`.
function prepared(next, given, diff = DIFF) {
  return replied(next, next(given, CTX, []), diff);
}

// The step after the stage's session replied with `output`.
function decided(next, given, output) {
  const step = prepared(next, given);
  return sessionEnded(next, step, { ok: true, structuredOutput: output });
}

// A child's whole task: the preamble for `role` and `cap`, then `lines`.
function taskOf(role, cap, lines) {
  return preamble(CFG, { n: 7, paths: PATHS }, role, cap)
    .concat(lines)
    .join("\n");
}

export {
  CFG,
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
