// Fixtures for driving the review and fix step machines directly: a context
// with a fixed clock, issue #7's state with its PR open, signed results, a
// finding, and the tasks the sweep has always written for each session.
import { findingsText } from "../src/workflow/findings.ts";
import { LENSES } from "../src/workflow/lenses.ts";
import { practicesNote, preamble } from "../src/workflow/prompts.ts";

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
  practices: ["CONTRIBUTING.md"],
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
};
const ISSUE_BUDGET = 1_000_000;
const DIFF = { path: "/runs/issue-7/r0.diff", lines: 40 };
const OFF_BY_ONE = {
  file: "src/a.ts",
  line: 3,
  title: "Off by one",
  evidence: "The loop stops one item early.",
  suggestion: "Use <= in the loop bound.",
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

// Issue #7 at `stage` with its PR open, with `fields` replacing its saved
// state's.
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
      allocated: 0,
      sessions: [],
      round: 0,
      findings: [],
      resolvedHistory: [],
      log: [],
      ...fields,
    },
    closed: false,
    outcome: null,
    phase: "begin",
    carry: null,
  };
}

// An open finding numbered `id`, raised by `lenses`.
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
function signatureOf(name) {
  return { role: name, agent: "issue-pipeline-reader", model: "m", run: name };
}

// A session launched as `name` that replied with `output`.
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
function failed(name, error) {
  return {
    kind: "child",
    ok: false,
    structuredOutput: null,
    error,
    by: signatureOf(name),
  };
}

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
function specLines(spec, rule) {
  if (spec === null) {
    return [];
  }
  return [SPEC_HEADING, spec, rule];
}

// The first reviewer's whole task for `lens`, with `spec` if the issue has one.
function lensTask(lens, spec = null) {
  return preamble(CFG, ITEM, `reviewer (${lens})`, ROLES.reviewer)
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
function aggregateTask(raw) {
  return preamble(CFG, ITEM, "review aggregator", ROLES.aggregator)
    .concat([
      "Three reviewers reported these blocking findings. Merge duplicates (same defect at the same place) into one entry listing every lens that raised it. Keep every distinct finding; do not drop or downgrade any. Do not edit files.",
      "",
      JSON.stringify(raw, null, 1),
    ])
    .join("\n");
}

// The fixer's whole task for `round` over the `open` findings, with `spec`
// if the issue has one.
function fixTask(round, open, disputed = "none", spec = null) {
  return preamble(CFG, ITEM, `fixer, round ${round} of 2`, ROLES.fixer)
    .concat([
      practicesNote(CFG, ITEM, "writer"),
      ...specLines(spec, FIX_RULE),
      "Resolve these blocking review findings:",
      findingsText(open),
      "",
      `For each finding, either fix it (list its id in \`fixed\`) or, if you have concrete evidence it is wrong, dispute it (list it in \`disputed\` with the evidence). Findings already disputed once cannot be disputed again: ${disputed}.`,
      `Make only the changes the findings need. Run the tests, then commit (\`git add -A && git commit\`, ending each message with the trailer line \`Pipeline-Agent: fixer round ${round}\`) and leave the worktree clean.`,
    ])
    .join("\n");
}

// The re-reviewer's whole task for `lens` over `mine`, with the findings
// `resolved` before, and `spec` if the issue has one.
function rereviewTask(
  lens,
  diffPath,
  mine,
  { resolved = "none", spec = null } = {},
) {
  return preamble(CFG, ITEM, `re-reviewer (${lens})`, ROLES.rereviewer)
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
