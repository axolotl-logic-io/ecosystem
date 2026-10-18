// What the review rounds say: the tasks of the first reviewers, the
// aggregator, the fixer and the re-reviewers, and the comments the review and
// fix rounds post on the PR.

import { findingLines, findingsText } from "../findings.ts";
import type { Lens } from "../lenses.ts";
import { LENSES } from "../lenses.ts";
import { practicesNote } from "../practices.ts";
import {
  beyondIssueRule,
  commitRulesOf,
  handoffLead,
  handoffRule,
  NO_ARTIFICIAL_LOAD_RULE,
  preamble,
  specText,
} from "../prompts.ts";
import type { Finding, ListedFinding } from "../types.ts";
import type {
  FixReply,
  NewFinding,
  RawFinding,
  RereviewReply,
  ReviewFinding,
} from "./review-replies.ts";
import type { StageContext, StageState } from "./types.ts";

// How much of a commit's hash a comment shows.
const SHORT_SHA = 12;

// The diff a review reads, as prepare-review wrote it.
interface ReviewDiff {
  path: string;
  lines: string;
}

// What a reviewer or re-reviewer does with the spec.
const SPEC_RULE_REVIEW =
  "A finding must not ask for a change the spec forbids.";
// What a first reviewer returns, after its lens and what it reads.
const LENS_OUTPUT_RULES: readonly string[] = [
  "Mark a finding `blocking` only for a concrete defect you can show with evidence (file, line, and why). Style preferences and optional improvements are `nit`.",
  "Return an empty list if you find nothing. Do not edit files.",
];
// What the fixer does with the spec.
const SPEC_RULE_FIX =
  "Fix each finding in a way the spec allows. If a finding can only be met by breaking the spec, dispute it and quote the spec line.";

// The issue's spec as lines of a task, followed by `rule`, which says what
// the role does with it. No lines when no spec stage ran.
function specSection(state: StageState, rule: string): string[] {
  const spec = specText(state.st);
  if (spec === "") {
    return [];
  }
  return [
    "Spec (the acceptance check judges the result against it):",
    spec,
    rule,
  ];
}

// The first reviewer's task for `lens`.
function lensTask(
  ctx: StageContext,
  state: StageState,
  lens: Lens,
  diff: ReviewDiff,
): string {
  const { cfg } = ctx;
  const role = `reviewer (${lens})`;
  return preamble(cfg, state, role)
    .concat([
      `Review only this concern: ${LENSES[lens]}`,
      practicesNote(cfg, state, "reviewer"),
      ...specSection(state, SPEC_RULE_REVIEW),
      `The diff against ${cfg.baseBranch} is at ${diff.path} (${diff.lines} lines). Read it, then read surrounding code only where needed.`,
      ...LENS_OUTPUT_RULES,
    ])
    .join("\n");
}

function blockingSection(blocking: readonly ListedFinding[]): string {
  if (blocking.length === 0) {
    return "No blocking findings.\n\n";
  }
  return `**Blocking**\n\n${findingLines(blocking)}\n\n`;
}

function nitSection(nits: readonly ListedFinding[]): string {
  if (nits.length === 0) {
    return "";
  }
  return `**Non-blocking** (the pipeline won't act on these)\n\n${findingLines(nits)}`;
}

// A first reviewer's comment on the head it reviewed.
function lensComment(
  headSha: string,
  lens: Lens,
  blocking: readonly ReviewFinding[],
  nits: readonly ReviewFinding[],
): string {
  return `Review of ${headSha.slice(0, SHORT_SHA)} for ${lens}.\n\n${blockingSection(blocking)}${nitSection(nits)}`;
}

// The aggregator's task: merge the raw blocking findings.
function aggregateTask(
  ctx: StageContext,
  state: StageState,
  raw: readonly RawFinding[],
): string {
  const { cfg } = ctx;
  return preamble(cfg, state, "review aggregator")
    .concat([
      "Three reviewers reported these blocking findings. Merge duplicates (same defect at the same place) into one entry listing every lens that raised it. Keep every distinct finding; do not drop or downgrade any. Do not edit files.",
      "",
      JSON.stringify(raw, null, 1),
    ])
    .join("\n");
}

// The comment that numbers the blocking findings for the fixer.
function findingIdsComment(added: readonly Finding[]): string {
  const lines = added.map(
    (f) =>
      `- **${f.id}** \`${f.file}:${f.line}\` ${f.title} (raised by ${f.lenses.join(", ")})`,
  );
  return `Blocking findings for the fixer, with duplicates merged. Later comments refer to these ids.\n\n${lines.join("\n")}`;
}

function disputedIds(open: readonly Finding[]): string {
  const ids = open.filter((f) => f.disputed).map((f) => f.id);
  if (ids.length === 0) {
    return "none";
  }
  return ids.join(", ");
}

// What a fixer works on: its round, the findings still open, and whether it
// continues from a predecessor's handoff in the same round.
interface FixJob {
  round: number;
  open: readonly Finding[];
  continuation: boolean;
}

// The fixer's task for its job; a continuation starts from the handoff.
function fixTask(ctx: StageContext, state: StageState, job: FixJob): string {
  const { cfg, budgets } = ctx;
  const { round, open } = job;
  const { handoffFile } = state.paths;
  const role = `fixer, round ${round} of ${cfg.maxFixRounds}`;
  const lead: string[] = [];
  if (job.continuation) {
    lead.push(handoffLead(handoffFile));
  }
  return preamble(cfg, state, role)
    .concat([
      ...lead,
      practicesNote(cfg, state, "writer"),
      ...specSection(state, SPEC_RULE_FIX),
      "Resolve these blocking review findings:",
      findingsText(open),
      "",
      `For each finding, either fix it (list its id in \`fixed\`) or, if you have concrete evidence it is wrong, dispute it (list it in \`disputed\` with the evidence). Findings already disputed once cannot be disputed again: ${disputedIds(open)}.`,
      ...commitRulesOf(ctx.committer, {
        unit: "fix",
        when: "as soon as it works",
        trailer: `Pipeline-Agent: fixer round ${round}`,
        clearMessage: false,
      }),
      beyondIssueRule(cfg.baseBranch, "`summary`, which is posted on the PR"),
      NO_ARTIFICIAL_LOAD_RULE,
      "Run the tests, commit what is left and leave the worktree clean. Return status `done` when you finish.",
      handoffRule(budgets, handoffFile, "make it build and commit it"),
    ])
    .join("\n");
}

function disputeSection(reply: FixReply): string {
  if (reply.disputed.length === 0) {
    return "";
  }
  const lines = reply.disputed.map((d) => `- **${d.id}**: ${d.evidence}`);
  return `\n\nDisputed:\n${lines.join("\n")}`;
}

function fixedList(reply: FixReply): string {
  if (reply.fixed.length === 0) {
    return "none";
  }
  return reply.fixed.join(", ");
}

// The fixer's comment on its round.
function fixComment(reply: FixReply): string {
  return `${reply.summary}\n\nFixed: ${fixedList(reply)}${disputeSection(reply)}`;
}

function resolvedList(resolvedHistory: readonly string[]): string {
  if (resolvedHistory.length === 0) {
    return "none";
  }
  return resolvedHistory.join("; ");
}

// What a re-reviewer judges: its lens's open findings, in the fix diff.
interface RereviewScope {
  lens: Lens;
  diffPath: string;
  findings: readonly Finding[];
}

// The re-reviewer's task for its scope.
function rereviewTask(
  ctx: StageContext,
  state: StageState,
  { lens, diffPath, findings }: RereviewScope,
): string {
  const { cfg } = ctx;
  const role = `re-reviewer (${lens})`;
  return preamble(cfg, state, role)
    .concat([
      `Concern: ${LENSES[lens]}`,
      ...specSection(state, SPEC_RULE_REVIEW),
      `The fixer's changes since the last review are at ${diffPath}.`,
      "For each finding below, report `resolved` or `unresolved`. Where the fixer disputed a finding, report `dispute-accepted` if the evidence holds or `dispute-rejected` if not.",
      findingsText(findings),
      "",
      "Report a new finding only if this fix diff introduced it. Do not raise issues you could have raised before.",
      `If a new finding is the same defect as one already resolved earlier, set \`recursId\` to that id; otherwise use an empty string. Previously resolved: ${resolvedList(state.st.resolvedHistory ?? [])}.`,
      "Do not edit files.",
    ])
    .join("\n");
}

function verdictLine(id: string, status: string, note: string): string {
  if (note === "") {
    return `- **${id}**: ${status}`;
  }
  return `- **${id}**: ${status} — ${note}`;
}

function addedSection(added: readonly Finding[]): string {
  if (added.length === 0) {
    return "";
  }
  return `\n\n**New blocking findings the fix introduced**\n\n${findingLines(added)}`;
}

function recurringSection(recurring: readonly NewFinding[]): string {
  if (recurring.length === 0) {
    return "";
  }
  const lines = recurring.map(
    (f) => `- was ${f.recursId}: \`${f.file}:${f.line}\` ${f.title}`,
  );
  return `\n\n**Findings that came back after being resolved**\n\n${lines.join("\n")}`;
}

// A re-reviewer's comment on the fix in `headSha`.
function rereviewComment(
  headSha: string,
  reply: RereviewReply,
  added: readonly Finding[],
  recurring: readonly NewFinding[],
): string {
  const verdicts = reply.results.map((x) =>
    verdictLine(x.id, x.status, x.note),
  );
  return `Re-review of the fix in ${headSha.slice(0, SHORT_SHA)}.\n\n${verdicts.join("\n")}${addedSection(added)}${recurringSection(recurring)}`;
}

export type { FixJob, RereviewScope, ReviewDiff };
export {
  aggregateTask,
  findingIdsComment,
  fixComment,
  fixTask,
  LENS_OUTPUT_RULES,
  lensComment,
  lensTask,
  rereviewComment,
  rereviewTask,
  SPEC_RULE_REVIEW,
  specSection,
};
