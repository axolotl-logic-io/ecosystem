// @ts-check
// Fixtures for driving triage's step machine directly: a context with a fixed
// clock, issue #7's state at triage, the reply, and the launch and task the
// sweep has always used.
import { preamble } from "../src/workflow/prompts.ts";
import { TRIAGE_SCHEMA } from "../src/workflow/schemas.ts";
import { hasRoom, modelsWith } from "./workflow-context-test-kit.mjs";

/** @import { Signature } from "../src/workflow/signing.ts" */
/** @import { ChildLaunch, StageContext, StageState } from "../src/workflow/stages/types.ts" */
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
const MODEL = "anthropic/claude-opus-5-5";
/** @type {Signature} */
const SIGNATURE = {
  role: "triage",
  agent: "issue-pipeline-reader",
  model: "claude-opus-5-5",
  run: "i7-triage-3",
};
const SPLIT_ALLOWED =
  "- split: too big for one session. Give 2 to 5 sub-issues, each a complete, independently testable change with its own acceptance criteria. Use `after` to list the 0-based indexes of earlier sub-issues that must merge first. Sub-issues without `after` run in parallel, and each merge makes the others rebase onto it, so two that edit the same file conflict and redo their checks. Cut along file boundaries: give each file to one sub-issue where you can, and name each one's files in its body. Where two must edit the same file, such as a shared index, registry or wiki page, put one `after` the other so they run in turn. Prefer fewer sub-issues to many that share files.";
const SPLIT_FORBIDDEN =
  "- split: NOT allowed; this issue is already a sub-issue. If it is still too big, choose reject and say so.";
const REJECTED = "triage rejected the issue for the agent pipeline";
const SUB_ISSUES = [
  { title: "First part", body: "Do the first part.", after: [] },
  { title: "Second part", body: "Do the second part.", after: [0] },
];

// Every kit's rebase pool (`rebaseTokenBudget`).
const REBASE_BUDGET = 500_000;

/** @param {number} issueBudget @returns {StageContext} */
function contextWith(issueBudget) {
  return {
    cfg: CFG,
    budgets: {
      roles: ROLES,
      sessionCap: 150_000,
      hardLimit: 175_000,
      issueBudget,
      rebaseBudget: REBASE_BUDGET,
    },
    models: modelsWith({ triage: MODEL }),
    now: () => NOW,
    hasRoom,
    mergeQueue: null,
  };
}

const ISSUE_BUDGET = 1_000_000;
const CTX = contextWith(ISSUE_BUDGET);

// Issue #7 at triage's first call, with `fields` replacing its saved state's.
/** @param {Partial<IssueState>} [fields] @returns {StageState} */
function stateWith(fields = {}) {
  return {
    n: 7,
    paths: PATHS,
    st: {
      stage: "triage",
      depth: 0,
      pr: null,
      headSha: null,
      plan: null,
      allocated: 0,
      sessions: [],
      triages: 0,
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

// The triage reply, with `fields` replacing the empty decision's.
/** @param {object} fields @returns {object} */
function replyOf(fields) {
  return {
    decision: "ready",
    reason: "",
    questions: [],
    subIssues: [],
    plan: "",
    ...fields,
  };
}

// The session's whole task, as the sweep has always written it.
/** @param {string} splitLine @returns {string} */
function expectedTask(splitLine) {
  return preamble(CFG, { n: 7, paths: PATHS }, "triage", ROLES.triage)
    .concat([
      "If /runs/issue-7/handoff.md exists, an earlier implementer session wrote it when it ran out of room: read it and the commits on `agent/issue-7` before you decide.",
      "Read the issue and as much of the code as you need to decide one of:",
      "- ready: one implementer session (at most 150000 tokens of context) can implement and test it. Write `plan`: at most 15 lines naming the files and approach you found. A spec writer turns it into the full spec next.",
      "- needs-info: a competent engineer could not start without answers. Ask at most 5 specific questions. If earlier questions were answered in the comments, use the answers.",
      splitLine,
      "- reject: not suitable for an agent (design debate, production incident, needs production access, not a code change). Explain in `reason`. Issues that change CI workflows, auth, dependencies or migrations are suitable.",
      "Leave unused fields as empty strings or arrays.",
    ])
    .join("\n");
}

/** @param {string} task @returns {ChildLaunch} */
function sessionLaunch(task) {
  return {
    kind: "child",
    name: "triage",
    label: "Triage issue 7",
    agent: "issue-pipeline-reader",
    model: MODEL,
    schema: TRIAGE_SCHEMA,
    minutes: 20,
    tokenBudget: ROLES.triage,
    task,
  };
}

export {
  CTX,
  contextWith,
  expectedTask,
  PATHS,
  REJECTED,
  replyOf,
  SIGNATURE,
  SPLIT_ALLOWED,
  SPLIT_FORBIDDEN,
  STAMP,
  SUB_ISSUES,
  sessionLaunch,
  stateWith,
};
