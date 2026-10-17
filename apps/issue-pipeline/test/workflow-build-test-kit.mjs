// @ts-check
// Fixtures for driving the spec, implement and open-pr step machines directly:
// a context with a fixed clock, issue #7's state at a stage, the signatures,
// and the launches and tasks the sweep has always used.
import {
  NO_ARTIFICIAL_LOAD_RULE,
  practicesNote,
  preamble,
} from "../src/workflow/prompts.ts";
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
// contextLimits.soft, and the split bound: two implementer sessions (#413).
const SOFT_LIMIT = 175_000;
const SPLIT_BOUND = 2 * SOFT_LIMIT;
const SPEC_MODEL = "anthropic/claude-opus-5-5";
const IMPL_MODEL = "anthropic/claude-sonnet-5-5";
const PLAN = "Change src/a.ts and test it.";
// The tokens triage was charged.
const TRIAGE_TOKENS = 50_000;
const SPEC = "## Behaviour\n\n1. src/a.ts does the thing.";
// The line a whole spec ends with (#280), and SPEC as the spec writer writes it.
const SPEC_END = "<!-- end of spec -->";
const SPEC_REPLY = `${SPEC}\n\n${SPEC_END}`;

/** @returns {StageContext} */
function contextWith() {
  return {
    cfg: CFG,
    budgets: {
      roles: ROLES,
      sessionCap: SESSION_CAP,
      softLimit: SOFT_LIMIT,
      hardLimit: 225_000,
    },
    models: modelsWith({ spec: SPEC_MODEL, implementer: IMPL_MODEL }),
    now: () => NOW,
    hasRoom,
    mergeQueue: null,
    committer: "git",
  };
}

const BUILD_CTX = contextWith();

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
  return preamble(CFG, item, "spec writer")
    .concat([
      `Triage found this issue ready. Its notes:\n${PLAN}`,
      "",
      `Write the spec the implementer will build to and the acceptance check will judge against. Read, in this order: the issue; the project's coding practices (below); the wiki pages that bear on it${start}; the code it touches; and, only for what the repo can't answer, the web (library APIs, standards, platform limits). Cite each source.`,
      practicesNote(CFG, item, "spec"),
      NO_ARTIFICIAL_LOAD_RULE,
      "`spec` is GitHub markdown with these sections:",
      "- **Behaviour**: what is true when the issue is done, as checkable statements.",
      "- **Out of scope**: what this issue does not change.",
      "- **Design**: the approach, with `file:line` anchors to the code it builds on, and the coding practices and wiki decisions it follows. If it departs from a wiki decision, say which and why, and say the implementer must update that wiki page.",
      "- **Tests**: the tests to add or change, each naming the behaviour it pins down and why it fails today.",
      '- **Wiki updates**: wiki pages to add or change, or "None".',
      "- **Assumptions and risks**, then **Sources** (files, wiki pages, URLs).",
      "Keep it under about 150 lines. Set `decision` to ready, with `questions` and `subIssues` empty.",
      "Only if the work can't be specified without a maintainer's answer, set `decision` to needs-info, ask at most 5 specific questions, put what you found so far in `spec`, and leave `subIssues` empty.",
      `Only if implementing and testing it would take more than two implementer sessions (more than ${SPLIT_BOUND} tokens of context, twice \`contextLimits.soft\`), set \`decision\` to split and give 2 to 5 \`subIssues\`, each a complete, independently testable change with its own acceptance criteria that two implementer sessions can implement and test. Put its slice of the spec in its \`body\`. Use \`after\` to list the 0-based indexes of earlier parts that must merge first. Parts without \`after\` run in parallel, and each merge makes the others rebase onto it, so two that edit the same file conflict and redo their checks. Cut along file boundaries: give each file to one part where you can. Where two must edit the same file, such as a shared index, registry or wiki page, put one \`after\` the other so they run in turn. Prefer fewer parts to many that share files.`,
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
    budgetRole: "spec",
    tokenBudget: ROLES.spec,
    task,
  };
}

// The implementer's whole task, working from `source`, as the sweep has
// always written it.
/** @param {string} source @returns {string} */
function implementTask(source) {
  const item = { n: 7, paths: PATHS };
  return preamble(CFG, item, "implementer")
    .concat([
      practicesNote(CFG, item, "writer"),
      source,
      "",
      "Do this:",
      "1. Write or update tests that specify the fix. They must fail without your change.",
      "2. Implement the change that resolves the issue.",
      "3. Run the tests (`npm test`), lint (`npm run lint`) and fix failures.",
      "4. Commit as you go (see below), and commit what is left at the end. Leave the worktree clean.",
      `5. Make the wiki updates the spec lists, and record any new design decision, in the wiki checkout: edit its pages, then commit there (\`git -C ${WIKI} add -A && git -C ${WIKI} commit\`, same trailer). Leave it clean too. Reviewers see those commits, and they reach the wiki when the PR merges.`,
      "Change lockfiles only through the package manager, never by hand.",
      "Scope doesn't limit you to the issue: fix anything broken you find while you work, such as bugs or flaky or broken tests and checks, including breakage on integration, and simplify, remove code smells or refactor the code you work in so the change has a better design. Keep the issue's change the main one, commit each such fix or improvement as its own commit with a message that says what it does and why, keep the tests passing, and name each one in `prBody`.",
      NO_ARTIFICIAL_LOAD_RULE,
      "",
      "Commit often, in small working steps: commit each step with `git add -A && git commit` and a clear message as soon as it builds and its tests pass, ending each message with the trailer line `Pipeline-Agent: implementer`. Don't save your work for one commit at the end; a session that is stopped or killed loses whatever it hasn't committed.",
      `Context limits: at 175000 tokens of context, if the work isn't done, wrap up: finish the edit you are in the middle of and start no new ones, make it build and commit it, then write ${HANDOFF} as a summary for the next round (what is done; what is left, in order; the decisions you made and why; the traps and dead ends you found; and the branch state, with the last commit and whether the checks pass), and return status \`handoff\`. The next session starts from your summary alone. At 225000 tokens of context the session is stopped.`,
      "Return `blocked` only if the issue cannot be done as written; explain in `summary`.",
      "`prTitle` and `prBody` describe the change for reviewers (body: what changed and why, how it is tested, and each fix or improvement beyond the issue).",
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
    budgetRole: "implementer",
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
