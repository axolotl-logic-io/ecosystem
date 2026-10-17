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
  "- split: too big for one session. Say why in `reason` and write `plan` as for ready; the spec writer decides how to cut it.";
const SPLIT_FORBIDDEN =
  "- split: NOT allowed; this issue is already a sub-issue. If it is still too big, choose reject and say so.";
const REJECTED = "triage rejected the issue for the agent pipeline";

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
    models: modelsWith({ triage: MODEL }),
    now: () => NOW,
    hasRoom,
    mergeQueue: null,
  };
}

const CTX = contextWith();

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
    plan: "",
    ...fields,
  };
}

// The session's whole task, as the sweep has always written it.
/** @param {string} splitLine @returns {string} */
function expectedTask(splitLine) {
  return preamble(CFG, { n: 7, paths: PATHS }, "triage")
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
    budgetRole: "triage",
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
  sessionLaunch,
  stateWith,
};
