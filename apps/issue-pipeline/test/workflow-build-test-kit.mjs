// @ts-check
// Fixtures for driving the spec, implement and open-pr step machines directly:
// a context with a fixed clock, issue #7's state at a stage, the signatures,
// and the launches and tasks the sweep has always used.
import { practicesNote, preamble } from "../src/workflow/prompts.ts";
import { IMPL_SCHEMA, SPEC_SCHEMA } from "../src/workflow/schemas.ts";
import { hasRoom, modelsWith } from "./workflow-context-test-kit.mjs";

/** @import { Signature } from "../src/workflow/signing.ts" */
/** @import { ChildLaunch, OpResult, StageContext, StageMachine, StageState, Step } from "../src/workflow/stages/types.ts" */
/** @import { IssueState, ItemPaths } from "../src/workflow/types.ts" */
/** @import { Ended } from "./workflow-context-test-kit.mjs" */

const NOW = new Date("2026-10-15T12:00:30Z");
const STAMP = "2026-10-15T12:00Z";
const WIKI = "/w/issue-7/wiki";
const HANDOFF = "/runs/issue-7/handoff.md";
/** @type {ItemPaths} */
const PATHS = {
  worktree: "/w/issue-7",
  issueFile: "/runs/issue.md",
  wiki: WIKI,
  handoffFile: HANDOFF,
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
  practices: ["AGENTS.md", "CONTRIBUTING.md"],
  commands: { test: "npm test", lint: "npm run lint" },
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
const SESSION_CAP = 150_000;
const SPEC_MODEL = "anthropic/claude-opus-5-5";
const IMPL_MODEL = "anthropic/claude-sonnet-5-5";
const PLAN = "Change src/a.ts and test it.";
// The tokens triage was charged.
const TRIAGE_TOKENS = 50_000;
const SPEC = "## Behaviour\n\n1. src/a.ts does the thing.";
// The line a whole spec ends with (#280), and SPEC as the spec writer writes it.
const SPEC_END = "<!-- end of spec -->";
const SPEC_REPLY = `${SPEC}\n\n${SPEC_END}`;

// Every kit's rebase pool (`rebaseTokenBudget`).
const REBASE_BUDGET = 500_000;

/** @param {number} issueBudget @returns {StageContext} */
function contextWith(issueBudget) {
  return {
    cfg: CFG,
    budgets: {
      roles: ROLES,
      sessionCap: SESSION_CAP,
      hardLimit: 175_000,
      issueBudget,
      rebaseBudget: REBASE_BUDGET,
    },
    models: modelsWith({ spec: SPEC_MODEL, implementer: IMPL_MODEL }),
    now: () => NOW,
    hasRoom,
    mergeQueue: null,
  };
}

const ISSUE_BUDGET = 1_000_000;
const BUILD_CTX = contextWith(ISSUE_BUDGET);

// Issue #7 at `stage`'s first call, after triage, with `fields` replacing its
// saved state's.
/**
 * @param {string} stage @param {Partial<IssueState>} [fields]
 * @param {ItemPaths} [paths]
 * @returns {StageState}
 */
function buildState(stage, fields = {}, paths = PATHS) {
  return {
    n: 7,
    paths,
    st: {
      stage,
      depth: 0,
      pr: 42,
      headSha: "aaaaaaa",
      implemented: false,
      plan: PLAN,
      allocated: TRIAGE_TOKENS,
      sessions: ["triage"],
      continuations: {},
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

// The signature the sweep gives a session of `role`, launched as `run`.
/** @param {string} role @param {string} agent @param {string} run @returns {Signature} */
function signature(role, agent, run) {
  return { role, agent, model: "claude-opus-5-5", run };
}

const SPEC_BY = signature(
  "spec writer",
  "issue-pipeline-specifier",
  "i7-spec-4",
);
const IMPL_BY = signature(
  "implementer",
  "issue-pipeline-writer",
  "i7-implement-6",
);

// The spec writer's whole task, as the sweep has always written it.
/** @param {ItemPaths} [paths] @returns {string} */
function specTask(paths = PATHS) {
  const item = { n: 7, paths };
  let start = "";
  if (paths.wiki) {
    start = ` (start from ${paths.wiki}/Home.md)`;
  }
  return preamble(CFG, item, "spec writer", ROLES.spec)
    .concat([
      `Triage found this issue ready. Its notes:\n${PLAN}`,
      "",
      `Write the spec the implementer will build to and the acceptance check will judge against. Read, in this order: the issue; the project's coding practices (below); the wiki pages that bear on it${start}; the code it touches; and, only for what the repo can't answer, the web (library APIs, standards, platform limits). Cite each source.`,
      practicesNote(CFG, item, "spec"),
      "`spec` is GitHub markdown with these sections:",
      "- **Behaviour**: what is true when the issue is done, as checkable statements.",
      "- **Out of scope**: what this issue does not change.",
      "- **Design**: the approach, the files to change with `file:line` anchors, and the coding practices and wiki decisions it follows. If it departs from a wiki decision, say which and why, and say the implementer must update that wiki page.",
      "- **Tests**: the tests to add or change, each naming the behaviour it pins down and why it fails today.",
      '- **Wiki updates**: wiki pages to add or change, or "None".',
      "- **Assumptions and risks**, then **Sources** (files, wiki pages, URLs).",
      "`files` lists the repo paths or globs the change will touch, relative to the repo root, without wiki pages (such as `src/a.ts` or `src/orchestrator/**`). The orchestrator holds back other changes that touch them.",
      "Keep it under about 150 lines. Set `decision` to ready, with `questions` empty.",
      "Only if the work can't be specified without a maintainer's answer, set `decision` to needs-info, ask at most 5 specific questions, and put what you found so far in `spec`.",
      `Whatever the decision, end \`spec\` with the line \`${SPEC_END}\`, written last, after every section. A spec without it counts as one that stopped partway.`,
    ])
    .join("\n");
}

/** @param {string} task @returns {ChildLaunch} */
function specLaunch(task) {
  return {
    kind: "child",
    name: "spec",
    role: "spec writer",
    label: "Write the spec for issue 7",
    agent: "issue-pipeline-specifier",
    model: SPEC_MODEL,
    schema: SPEC_SCHEMA,
    minutes: 30,
    tokenBudget: ROLES.spec,
    task,
  };
}

// The implementer's whole task, working from `source`, as the sweep has
// always written it.
/** @param {string} source @returns {string} */
function implementTask(source) {
  const item = { n: 7, paths: PATHS };
  return preamble(CFG, item, "implementer", SESSION_CAP)
    .concat([
      practicesNote(CFG, item, "writer"),
      source,
      "",
      "Do this:",
      "1. Write or update tests that specify the fix. They must fail without your change.",
      "2. Implement the smallest change that resolves the issue. Do not refactor unrelated code.",
      "3. Run the tests (`npm test`), lint (`npm run lint`) and fix failures.",
      "4. Commit everything with clear messages (`git add -A && git commit`), ending each message with the trailer line `Pipeline-Agent: implementer`. Leave the worktree clean.",
      `5. Make the wiki updates the spec lists, and record any new design decision, in the wiki checkout: edit its pages, then commit there (\`git -C ${WIKI} add -A && git -C ${WIKI} commit\`, same trailer). Leave it clean too. Reviewers see those commits, and they reach the wiki when the PR merges.`,
      "Change lockfiles only through the package manager, never by hand.",
      "",
      `Hard limit: 175000 tokens of context. If this session passes it before the work is done, stop: commit what builds, write ${HANDOFF} (what is done, what is left, current branch state), and return status \`handoff\`. A new session continues from your handoff.`,
      "Return `blocked` only if the issue cannot be done as written; explain in `summary`.",
      "`prTitle` and `prBody` describe the change for reviewers (body: what changed and why, and how it is tested).",
    ])
    .join("\n");
}

/** @param {string} task @returns {ChildLaunch} */
function implementLaunch(task) {
  return {
    kind: "child",
    name: "implement",
    role: "implementer",
    label: "Implement issue 7",
    agent: "issue-pipeline-writer",
    model: IMPL_MODEL,
    schema: IMPL_SCHEMA,
    writer: true,
    minutes: 90,
    tokenBudget: SESSION_CAP,
    task,
  };
}

// The step after `step`'s one session ends with `result`, signed `by`.
/**
 * @param {StageMachine["next"]} next @param {Step} step @param {Signature} by
 * @param {Ended} result
 * @returns {Step}
 */
function afterSession(next, step, by, result) {
  return next(step.state, BUILD_CTX, [
    { kind: "child", error: null, by, ...result },
  ]);
}

// The step after `step`'s one ops request gets `reply`.
/** @param {StageMachine["next"]} next @param {Step} step @param {OpResult["reply"]} reply @returns {Step} */
function afterReply(next, step, reply) {
  return next(step.state, BUILD_CTX, [{ kind: "op", reply }]);
}

export {
  afterReply,
  afterSession,
  BUILD_CTX,
  buildState,
  contextWith,
  HANDOFF,
  IMPL_BY,
  implementLaunch,
  implementTask,
  PATHS,
  PLAN,
  SPEC,
  SPEC_BY,
  SPEC_END,
  SPEC_REPLY,
  STAMP,
  specLaunch,
  specTask,
  TRIAGE_TOKENS,
};
