// The spec writer's task: what to read, the sections of `spec`, when and how
// to split the issue, and the end marker it writes last.

import { practicesNote, preamble } from "../prompts.ts";
import type { IssueState } from "../types.ts";
import { SPEC_END } from "./build-replies.ts";
import type { StageContext, StageState } from "./types.ts";

const ROLE = "spec writer";

function planText(plan: string | null | undefined): string {
  if (typeof plan !== "string" || plan === "") {
    return "(none)";
  }
  return plan;
}

// What triage found: the issue ready, or too big for one session, with its
// notes.
function triageFinding(st: IssueState): string {
  const notes = `Its notes:\n${planText(st.plan)}`;
  const { splitSuggested } = st;
  if (typeof splitSuggested !== "string") {
    return `Triage found this issue ready. ${notes}`;
  }
  return `Triage judged this issue too big for one session: ${splitSuggested} Split it unless your spec shows the change fits one session. ${notes}`;
}

// The line on splitting: a sub-issue may not split again.
function splitOption(depth: number, sessionCap: number): string {
  if (depth >= 1) {
    return "Don't set `decision` to split: this issue is already a sub-issue, so splitting is not allowed. Leave `subIssues` empty.";
  }
  return `Only if one implementer session (at most ${sessionCap} tokens of context) can't implement and test it, set \`decision\` to split and give 2 to 5 \`subIssues\`, each a complete, independently testable change with its own acceptance criteria. Put its slice of the spec in its \`body\`, and in its \`files\` the paths from \`files\` it touches. Use \`after\` to list the 0-based indexes of earlier parts that must merge first. Parts without \`after\` run in parallel, and each merge makes the others rebase onto it, so two that edit the same file conflict and redo their checks. Cut along file boundaries: give each file to one part where you can. Where two must edit the same file, such as a shared index, registry or wiki page, put one \`after\` the other so they run in turn. Prefer fewer parts to many that share files.`;
}

// Where the spec writer starts reading the wiki, or "" when there is none.
function wikiStart(state: StageState): string {
  const { wiki } = state.paths;
  if (wiki === null || wiki === "") {
    return "";
  }
  return ` (start from ${wiki}/Home.md)`;
}

// The spec writer's whole task.
function specTask(
  state: StageState,
  ctx: StageContext,
  budget: number,
): string {
  const { cfg, budgets } = ctx;
  const lines = [
    triageFinding(state.st),
    "",
    `Write the spec the implementer will build to and the acceptance check will judge against. Read, in this order: the issue; the project's coding practices (below); the wiki pages that bear on it${wikiStart(state)}; the code it touches; and, only for what the repo can't answer, the web (library APIs, standards, platform limits). Cite each source.`,
    practicesNote(cfg, state, "spec"),
    "`spec` is GitHub markdown with these sections:",
    "- **Behaviour**: what is true when the issue is done, as checkable statements.",
    "- **Out of scope**: what this issue does not change.",
    "- **Design**: the approach, the files to change with `file:line` anchors, and the coding practices and wiki decisions it follows. If it departs from a wiki decision, say which and why, and say the implementer must update that wiki page.",
    "- **Tests**: the tests to add or change, each naming the behaviour it pins down and why it fails today.",
    '- **Wiki updates**: wiki pages to add or change, or "None".',
    "- **Assumptions and risks**, then **Sources** (files, wiki pages, URLs).",
    "`files` lists the repo paths or globs the change will touch, relative to the repo root, without wiki pages (such as `src/a.ts` or `src/orchestrator/**`). The orchestrator holds back other changes that touch them.",
    "Keep it under about 150 lines. Set `decision` to ready, with `questions` and `subIssues` empty.",
    "Only if the work can't be specified without a maintainer's answer, set `decision` to needs-info, ask at most 5 specific questions, put what you found so far in `spec`, and leave `subIssues` empty.",
    splitOption(state.st.depth, budgets.sessionCap),
    `Whatever the decision, end \`spec\` with the line \`${SPEC_END}\`, written last, after every section. A spec without it counts as one that stopped partway.`,
  ];
  return preamble(cfg, state, ROLE, budget).concat(lines).join("\n");
}

export { ROLE, specTask };
