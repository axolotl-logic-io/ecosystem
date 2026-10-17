// @ts-check
// Fixtures for driving the review and fix step machines directly: a context
// with a fixed clock, issue #7's state with its PR open, signed results, a
// finding, and the tasks the sweep has always written for each session.
import { findingsText } from "../src/workflow/findings.ts";
import { LENSES } from "../src/workflow/lenses.ts";
import {
  NO_ARTIFICIAL_LOAD_RULE,
  practicesNote,
  preamble,
} from "../src/workflow/prompts.ts";
import { hasRoom } from "./workflow-context-test-kit.mjs";

/** @import { Lens } from "../src/workflow/lenses.ts" */
/** @import { ChildResult, OpResult, StageContext, StageState } from "../src/workflow/stages/types.ts" */
/** @import { Finding, IssueState, ItemPaths } from "../src/workflow/types.ts" */
/** @import { Signature } from "../src/workflow/signing.ts" */
/** @import { Models } from "./workflow-context-test-kit.mjs" */

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
  practices: ["CONTRIBUTING.md"],
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
const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
/** @type {Models} */
const MODELS = {
  triage: OPUS,
  spec: OPUS,
  implementer: OPUS,
  correctness: OPUS,
  tests: OPUS,
  scope: SONNET,
  aggregator: SONNET,
  fixer: OPUS,
  verifier: SONNET,
  security: OPUS,
  acceptance: SONNET,
};
const DIFF = { path: "/runs/issue-7/r0.diff", lines: 40 };
const OFF_BY_ONE = {
  file: "src/a.ts",
  line: 3,
  title: "Off by one",
  evidence: "The loop stops one item early.",
  suggestion: "Use <= in the loop bound.",
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
    models: MODELS,
    now: () => NOW,
    hasRoom,
    mergeQueue: null,
    committer: "git",
  };
}

const CTX = contextWith();

// Issue #7 at `stage` with its PR open, with `fields` replacing its saved
// state's.
/** @param {string} stage @param {Partial<IssueState>} [fields] @returns {StageState} */
function stateWith(stage, fields = {}) {
  return {
    n: 7,
    paths: PATHS,
    st: {
      stage,
      depth: 0,
      pr: 42,
      headSha: "bbbbbbb",
      reviewedSha: null,
      plan: null,
      round: 0,
      findings: [],
      resolvedHistory: [],
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

// An open finding numbered `id`, raised by `lenses`.
/** @param {string} id @param {string[]} lenses @param {Partial<Finding>} [fields] @returns {Finding} */
function openFinding(id, lenses, fields = {}) {
  return {
    id,
    ...OFF_BY_ONE,
    lenses,
    category: null,
    status: "open",
    disputed: false,
    ...fields,
  };
}

// The signature the sweep gives a session launched as `name`.
/** @param {string} name @returns {Signature} */
function signatureOf(name) {
  return { role: name, agent: "issue-pipeline-reader", model: "m", run: name };
}

// A session launched as `name` that replied with `output`.
/** @param {string} name @param {unknown} output @returns {ChildResult} */
function replied(name, output) {
  return {
    kind: "child",
    ok: true,
    structuredOutput: output,
    error: null,
    by: signatureOf(name),
  };
}

// A session launched as `name` that failed with `error`.
/** @param {string} name @param {string} error @returns {ChildResult} */
function failed(name, error) {
  return {
    kind: "child",
    ok: false,
    structuredOutput: null,
    error,
    by: signatureOf(name),
  };
}

/** @param {OpResult["reply"]} reply @returns {OpResult} */
function opReply(reply) {
  return { kind: "op", reply };
}

const ITEM = { n: 7, paths: PATHS };

const SPEC_HEADING =
  "Spec (the acceptance check judges the result against it):";
const REVIEW_RULE = "A finding must not ask for a change the spec forbids.";
const FIX_RULE =
  "Fix each finding in a way the spec allows. If a finding can only be met by breaking the spec, dispute it and quote the spec line.";

// The spec's lines in a task, followed by `rule`; none without a spec.
/** @param {string | null} spec @param {string} rule @returns {string[]} */
function specLines(spec, rule) {
  if (spec === null) {
    return [];
  }
  return [SPEC_HEADING, spec, rule];
}

// The first reviewer's whole task for `lens`, with `spec` if the issue has one.
/** @param {Lens} lens @param {string | null} [spec] @returns {string} */
function lensTask(lens, spec = null) {
  return preamble(CFG, ITEM, `reviewer (${lens})`)
    .concat([
      `Review only this concern: ${LENSES[lens]}`,
      practicesNote(CFG, ITEM, "reviewer"),
      ...specLines(spec, REVIEW_RULE),
      `The diff against integration is at ${DIFF.path} (${DIFF.lines} lines). Read it, then read surrounding code only where needed.`,
      "Mark a finding `blocking` only for a concrete defect you can show with evidence (file, line, and why). Style preferences and optional improvements are `nit`.",
      "Return an empty list if you find nothing. Do not edit files.",
    ])
    .join("\n");
}

// The aggregator's whole task over `raw`.
/** @param {unknown} raw @returns {string} */
function aggregateTask(raw) {
  return preamble(CFG, ITEM, "review aggregator")
    .concat([
      "Three reviewers reported these blocking findings. Merge duplicates (same defect at the same place) into one entry listing every lens that raised it. Keep every distinct finding; do not drop or downgrade any. Do not edit files.",
      "",
      JSON.stringify(raw, null, 1),
    ])
    .join("\n");
}

// The fixer's whole task for `round` over the `open` findings, with `spec`
// if the issue has one.
/**
 * @param {number} round @param {readonly Finding[]} open @param {string} [disputed]
 * @param {string | null} [spec]
 * @returns {string}
 */
function fixTask(round, open, disputed = "none", spec = null) {
  return preamble(CFG, ITEM, `fixer, round ${round} of 2`)
    .concat([
      practicesNote(CFG, ITEM, "writer"),
      ...specLines(spec, FIX_RULE),
      "Resolve these blocking review findings:",
      findingsText(open),
      "",
      `For each finding, either fix it (list its id in \`fixed\`) or, if you have concrete evidence it is wrong, dispute it (list it in \`disputed\` with the evidence). Findings already disputed once cannot be disputed again: ${disputed}.`,
      `Commit often, in small working steps: commit each fix with \`git add -A && git commit\` as soon as it works, ending each message with the trailer line \`Pipeline-Agent: fixer round ${round}\`. Don't save your work for one commit at the end; a session that is stopped or killed loses whatever it hasn't committed.`,
      "Scope doesn't limit you to the issue: fix anything broken you find while you work, such as bugs or flaky or broken tests and checks, including breakage on integration, and simplify, remove code smells or refactor the code you work in so the change has a better design. Keep the issue's change the main one, commit each such fix or improvement as its own commit with a message that says what it does and why, keep the tests passing, and name each one in `summary`, which is posted on the PR.",
      NO_ARTIFICIAL_LOAD_RULE,
      "Run the tests, commit what is left and leave the worktree clean. Return status `done` when you finish.",
      `Context limits: at 175000 tokens of context, if the work isn't done, wrap up: finish the edit you are in the middle of and start no new ones, make it build and commit it, then write ${PATHS.handoffFile} as a summary for the next round (what is done; what is left, in order; the decisions you made and why; the traps and dead ends you found; and the branch state, with the last commit and whether the checks pass), and return status \`handoff\`. The next session starts from your summary alone. At 225000 tokens of context the session is stopped.`,
    ])
    .join("\n");
}

// The re-reviewer's whole task for `lens` over `mine`, with the findings
// `resolved` before, and `spec` if the issue has one.
/**
 * @param {Lens} lens @param {string} diffPath @param {readonly Finding[]} mine
 * @param {{ resolved?: string, spec?: string | null }} [options]
 * @returns {string}
 */
function rereviewTask(
  lens,
  diffPath,
  mine,
  { resolved = "none", spec = null } = {},
) {
  return preamble(CFG, ITEM, `re-reviewer (${lens})`)
    .concat([
      `Concern: ${LENSES[lens]}`,
      ...specLines(spec, REVIEW_RULE),
      `The fixer's changes since the last review are at ${diffPath}.`,
      "For each finding below, report `resolved` or `unresolved`. Where the fixer disputed a finding, report `dispute-accepted` if the evidence holds or `dispute-rejected` if not.",
      findingsText(mine),
      "",
      "Report a new finding only if this fix diff introduced it. Do not raise issues you could have raised before.",
      `If a new finding is the same defect as one already resolved earlier, set \`recursId\` to that id; otherwise use an empty string. Previously resolved: ${resolved}.`,
      "Do not edit files.",
    ])
    .join("\n");
}

export {
  aggregateTask,
  CFG,
  CTX,
  contextWith,
  DIFF,
  failed,
  fixTask,
  ITEM,
  lensTask,
  OFF_BY_ONE,
  openFinding,
  opReply,
  replied,
  rereviewTask,
  SPEC_HEADING,
  STAMP,
  signatureOf,
  stateWith,
};
