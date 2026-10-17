// The spec writer role's session: its agent, model, context budget, reply
// schema and task. The task says what to read and in what order, what an
// earlier session of the stage committed and handed off, which it continues
// from (#335), the spec's sections and its test interfaces, the stubs,
// failing tests, spec draft and wiki updates the session commits as it goes,
// its context limits, and the decisions it may reply with. Pure.

import { SPEC_DRAFT } from "../../spec-draft.ts";
import type { Budgets } from "../../workflow/budget.ts";
import { sessionBudget, splitBound } from "../../workflow/budget.ts";
import {
  commitRulesOf,
  handoffLead,
  handoffRule,
  NO_ARTIFICIAL_LOAD_RULE,
  practicesNote,
  preamble,
} from "../../workflow/prompts.ts";
import { SPEC_END } from "../../workflow/stages/build-replies.ts";
import type { ModelRole } from "../../workflow/stages/types.ts";
import type {
  ItemPaths,
  PracticesConfig,
  RepoConfig,
} from "../../workflow/types.ts";
import type { SessionEffect } from "../machine.ts";
import { SPEC_WRITER_SCHEMA } from "./reply.ts";

// The agent every spec writer session runs as.
const SPEC_AGENT = "issue-pipeline-specifier";
// The role the session's comments are signed as.
const SPEC_ROLE = "spec writer";
// The stop reason once the session has failed twice.
const FAILED_TWICE = "the spec writer failed twice";
// The trailer line that ends every commit of a spec writer session, which
// marks it as the spec writer's own.
const SPEC_TRAILER = "Pipeline-Agent: spec writer";
// The wiki's folder in the checkout when it isn't under the worktree.
const DEFAULT_WIKI_DIR = "wiki";
// What a session keeps of its work when it wraps up at the soft limit.
const KEEP_SPEC_WORK = "commit the tests, stubs and spec draft you have";

// What the stage committed since its start heads: test files and other repo
// files (stubs) on the code branch, whether the spec draft is at its head,
// and the wiki pages changed on the wiki branch.
interface SpecCommitted {
  tests: readonly string[];
  stubs: readonly string[];
  wiki: readonly string[];
  draft: boolean;
}

// The issue a session specifies: its number, its paths, its depth (0 for an
// issue, 1 for a sub-issue), triage's plan and the reason it suggested a
// split, if any, the session's attempt (from 1), the failed check's output
// when this attempt is a retry, what the stage committed before it (null
// when not yet listed), and whether it continues a session that handed off.
interface SpecItem {
  n: number;
  paths: ItemPaths;
  depth: number;
  plan: string | undefined;
  splitSuggested: string | null | undefined;
  attempt: number;
  checkOutput: string | null;
  committed: SpecCommitted | null;
  continued: boolean;
}

interface SpecSettings {
  cfg: RepoConfig & PracticesConfig;
  budgets: Budgets;
  models: Readonly<Record<ModelRole, string>>;
}

// The wiki checkout's folder relative to the worktree, as an old state's
// `files` named a wiki page: `<dir>/<page>.md`.
function wikiDirOf(paths: ItemPaths): string {
  const { wiki, worktree } = paths;
  const prefix = `${worktree}/`;
  if (wiki === null || !wiki.startsWith(prefix) || wiki === prefix) {
    return DEFAULT_WIKI_DIR;
  }
  return wiki.slice(prefix.length);
}

function planText(plan: string | undefined): string {
  if (plan === undefined || plan === "") {
    return "(none)";
  }
  return plan;
}

// What triage found: the issue ready, or too big for two implementer sessions.
function triageFinding(item: SpecItem): string {
  const notes = `Its notes:\n${planText(item.plan)}`;
  const { splitSuggested } = item;
  if (typeof splitSuggested !== "string") {
    return `Triage found this issue ready. ${notes}`;
  }
  return `Triage judged this issue too big for two implementer sessions: ${splitSuggested} Split it unless your spec shows the change fits two sessions. ${notes}`;
}

function retryLines(item: SpecItem): string[] {
  if (item.checkOutput === null) {
    return [];
  }
  return [
    "",
    `Your previous attempt failed its check. Fix what it found; your earlier commits are on the branch. Its output:\n${item.checkOutput}`,
  ];
}

function listed(what: string, files: readonly string[]): string[] {
  if (files.length === 0) {
    return [];
  }
  return [`${what}: ${files.map((file) => `\`${file}\``).join(", ")}.`];
}

// What an earlier session of the stage left: the handoff to read first
// (a continuation's task leads with it instead), and the commits to continue
// from rather than start the spec over.
function resumeLines(item: SpecItem): string[] {
  const { committed, paths } = item;
  const lines = [""];
  if (!item.continued) {
    lines.push(
      `If ${paths.handoffFile} exists, an earlier spec writer session of this issue wrote it when it ran out of room: read it first, and build on it.`,
    );
  }
  if (committed === null) {
    return lines;
  }
  const { tests, stubs, wiki, draft } = committed;
  const found = [
    ...listed("Test files", tests),
    ...listed("Stubs and other repo files", stubs),
    ...listed(`Wiki pages (in ${paths.wiki ?? "the wiki"})`, wiki),
  ];
  if (draft) {
    found.push(`The spec draft: \`${SPEC_DRAFT}\`.`);
  }
  if (found.length === 0) {
    return lines;
  }
  return [
    ...lines,
    "An earlier session of this stage already committed these on the issue's branches:",
    ...found,
    "Continue from them: don't start the spec over, and don't rewrite the tests already committed; add what is left.",
  ];
}

function wikiStart(paths: ItemPaths): string {
  if (paths.wiki === null || paths.wiki === "") {
    return "";
  }
  return ` (start from ${paths.wiki}/Home.md)`;
}

function readingLines(item: SpecItem, cfg: SpecSettings["cfg"]): string[] {
  return [
    `Read, in this order: the project's coding practices (below), in full, before the code; then the issue, ${item.paths.issueFile}; the wiki pages that bear on it${wikiStart(item.paths)}; the code it touches; and, only for what the repo can't answer, the web (library APIs, standards, platform limits). Cite each source.`,
    practicesNote(cfg, item, "spec"),
  ];
}

const SECTION_LINES: readonly string[] = [
  "`spec` is GitHub markdown with these sections:",
  "- **Behaviour**: what is true when the issue is done, as checkable statements.",
  "- **Out of scope**: what this issue does not change.",
  "- **Design**: the approach, with `file:line` anchors to the code it builds on, and the coding practices and wiki decisions it follows. If it departs from a wiki decision, say which and why, and update that wiki page yourself.",
  "- **Test interfaces**: the public interfaces the tests drive, as in `interfaces`.",
  "- **Tests**: the test files you committed. Each test names the interface it drives, the Behaviour item it pins and why it fails today.",
  '- **Wiki updates**: the wiki pages you changed, or "None".',
  "- **Assumptions and risks**, then **Sources** (files, wiki pages, URLs).",
  "`interfaces` lists the same interfaces: for each, its `name` (several names that share a `where` may go in one entry, separated by commas, and a new entry's stub names each), its `kind`, `where` it lives (`file:line` for an existing one, the path for a new one), its `status` (existing, new or changed), its `signature` (its call shape), and the Behaviour items tests check through it in `behaviours`, quoted from the spec. Every Behaviour item is checked through at least one of them. List only interfaces the wiki or README promise or the change adds on purpose, never internals.",
  "`noTestsReason` is null, unless every test that could be written would test implementation rather than promised behaviour: then write no tests, say why there and in Tests, and `interfaces` may be empty.",
];

function workLines(item: SpecItem, budgets: Budgets): string[] {
  return [
    `Keep your spec draft in \`${SPEC_DRAFT}\` on the issue's branch (\`repo/${SPEC_DRAFT}\` as a pathspec), and commit the tests, stubs, spec draft and wiki pages with \`pipeline_commit\` as you go, not only at the end. The draft never merges: the pipeline removes it once your spec is posted.`,
    "Before you reply, commit to the issue's branch a stub at its `where` for each `new` interface that doesn't exist yet (its call shape, with a body that only throws or returns a not-implemented error, so the code builds and type-checks), and failing tests for every Behaviour item through the listed interfaces, unless `noTestsReason` applies. Each test fails because the behaviour is missing, not on a syntax, import or type error.",
    "Make the spec's Wiki updates yourself, in the wiki checkout.",
    "Change only test files, those stubs and wiki pages; write no behaviour. `wikiOnly` is true only when the wiki pages you changed are the whole change, with `noTestsReason` set; otherwise false.",
    "If your tests need a field or member an existing interface lacks, declare that interface `changed` in `interfaces`, with its file as `where`, and extend it there with type-only additions (fields or members of an interface, type alias or object type, optional properties, union members, `import type`, comments), removing no line; implementing it is the implementer's job.",
    "Every new source file needs its own `new` interface entry, unless a declared stub imports it, directly or through other new files, by a relative import.",
    NO_ARTIFICIAL_LOAD_RULE,
    ...commitRulesOf("pipeline_commit", {
      unit: "step",
      when: "as soon as it builds",
      trailer: SPEC_TRAILER,
      clearMessage: true,
    }),
    `${handoffRule(budgets, item.paths.handoffFile, KEEP_SPEC_WORK)} Your reply's other fields are ignored when its status is \`handoff\`; give your summary in \`summary\`. Otherwise set \`status\` to done, with a one-line \`summary\` of your decision.`,
  ];
}

// The line on splitting: offered past `bound` tokens of context, the most
// two implementer sessions take; a sub-issue may not split again.
function splitLine(depth: number, bound: number): string {
  if (depth >= 1) {
    return "Don't set `decision` to split: this issue is already a sub-issue, so splitting is not allowed. Leave `subIssues` empty.";
  }
  return `Only if implementing and testing it would take more than two implementer sessions (more than ${bound} tokens of context, twice \`contextLimits.soft\`), set \`decision\` to split and give 2 to 5 \`subIssues\`, each a complete, independently testable change with its own acceptance criteria that two implementer sessions can implement and test. Put its slice of the spec, with its interfaces, in its \`body\`. Use \`after\` to list the 0-based indexes of earlier parts that must merge first. Cut along file boundaries, order parts that must edit the same file with \`after\`, and prefer fewer parts.`;
}

function decisionLines(item: SpecItem, settings: SpecSettings): string[] {
  const { cfg, budgets } = settings;
  return [
    `The PR merges into ${cfg.baseBranch}, not into production. Releasing is never part of an issue's work: don't deploy or plan a step that does.`,
    "Set `decision` to ready, with `questions` and `subIssues` empty, once the spec, its tests and its stubs are committed.",
    "Set `decision` to no-work only if the issue's Behaviour already holds on the base: give the evidence in `spec` (where the behaviour lives, and how you checked). Any tests you commit to show it must pass.",
    "Only if the work can't be specified without a maintainer's answer, set `decision` to needs-info, ask at most 5 specific questions, and put what you found so far in `spec`.",
    splitLine(item.depth, splitBound(budgets)),
    `Whatever the decision, end \`spec\` with the line \`${SPEC_END}\`, written last, after every section. A spec without it counts as one that stopped partway.`,
  ];
}

// The spec writer session for `item`.
function specSession(item: SpecItem, settings: SpecSettings): SessionEffect {
  const { cfg, budgets, models } = settings;
  const lines = [
    triageFinding(item),
    ...retryLines(item),
    ...resumeLines(item),
    "",
    "Write the spec the implementer will build to and the acceptance check will judge against, with the failing tests and stubs it documents.",
    ...readingLines(item, cfg),
    ...SECTION_LINES,
    ...workLines(item, budgets),
    ...decisionLines(item, settings),
  ];
  const lead: string[] = [];
  if (item.continued) {
    lead.push(handoffLead(item.paths.handoffFile), "");
  }
  return {
    kind: "session",
    name: "spec",
    agent: SPEC_AGENT,
    model: models.spec,
    schema: SPEC_WRITER_SCHEMA,
    budgetRole: "spec",
    tokenBudget: sessionBudget(budgets, "spec"),
    attempt: item.attempt,
    task: [...lead, ...preamble(cfg, item, SPEC_ROLE), ...lines].join("\n"),
  };
}

export type { SpecCommitted, SpecItem, SpecSettings };
export {
  FAILED_TWICE,
  SPEC_AGENT,
  SPEC_ROLE,
  SPEC_TRAILER,
  specSession,
  wikiDirOf,
};
