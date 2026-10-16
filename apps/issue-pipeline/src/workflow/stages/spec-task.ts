// The spec writer's task: what to read, the sections of `spec`, and the end
// marker it writes last.

import { practicesNote, preamble } from "../prompts.ts";
import { SPEC_END } from "./build-replies.ts";
import type { StageContext, StageState } from "./types.ts";

const ROLE = "spec writer";

function planText(plan: string | null | undefined): string {
  if (typeof plan !== "string" || plan === "") {
    return "(none)";
  }
  return plan;
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
function specTask(state: StageState, ctx: StageContext): string {
  const { cfg, budgets } = ctx;
  const lines = [
    `Triage found this issue ready. Its notes:\n${planText(state.st.plan)}`,
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
    "Keep it under about 150 lines. Set `decision` to ready, with `questions` empty.",
    "Only if the work can't be specified without a maintainer's answer, set `decision` to needs-info, ask at most 5 specific questions, and put what you found so far in `spec`.",
    `Whatever the decision, end \`spec\` with the line \`${SPEC_END}\`, written last, after every section. A spec without it counts as one that stopped partway.`,
  ];
  return preamble(cfg, state, ROLE, budgets.roles.spec)
    .concat(lines)
    .join("\n");
}

export { ROLE, specTask };
