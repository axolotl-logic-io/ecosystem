// What triage says: its session's task, agent, model and context budget, the
// comments it posts, the reasons it stops with, the lines it adds to the
// issue's event log, and how long a plan the state keeps. Pure: workflow.js's
// triage stage and the triage role both build from it.

import type { Budgets } from "../../workflow/budget.ts";
import { sessionBudget, splitBound } from "../../workflow/budget.ts";
import { clip } from "../../workflow/clip.ts";
import { preamble } from "../../workflow/prompts.ts";
import { TRIAGE_SCHEMA } from "../../workflow/schemas.ts";
import type { ModelRole } from "../../workflow/stages/types.ts";
import type { ItemPaths, RepoConfig } from "../../workflow/types.ts";
import type { SessionEffect } from "../machine.ts";
import type { TriageDecision, TriageReply } from "./reply.ts";

// The agent every triage session runs as: a reader.
const TRIAGE_AGENT = "issue-pipeline-reader";
// The longest plan the state keeps.
const PLAN_LIMIT = 4000;
// The longest error a failed draft PR logs.
const PR_ERROR_LIMIT = 300;
const REJECTED = "triage rejected the issue for the agent pipeline";
// The stop reason for a reply that doesn't fit the schema.
const TRIAGE_FAILED = "triage failed";

// The issue a session triages: its number, its paths, its depth (0 for an
// issue, 1 for a sub-issue), and the session's attempt: how many times
// triage has run on the issue, this run included.
interface TriageItem {
  n: number;
  paths: ItemPaths;
  depth: number;
  attempt: number;
}

interface TriageSettings {
  cfg: RepoConfig;
  budgets: Budgets;
  models: Readonly<Record<ModelRole, string>>;
}

// The line on splitting: a sub-issue may not split again.
const SPLIT_ALLOWED: string =
  "- split: needs more than two implementer sessions. Say why in `reason` and write `plan` as for ready; the spec writer decides how to cut it.";
const SPLIT_FORBIDDEN: string =
  "- split: NOT allowed; this issue is already a sub-issue. If it is still too big, choose reject and say so.";

function splitLine(depth: number): string {
  if (depth >= 1) {
    return SPLIT_FORBIDDEN;
  }
  return SPLIT_ALLOWED;
}

// The triage session for `item`.
function triageSession(
  item: TriageItem,
  settings: TriageSettings,
): SessionEffect {
  const { cfg, budgets, models } = settings;
  const lines = [
    `If ${item.paths.handoffFile} exists, an earlier implementer session wrote it when it ran out of room: read it and the commits on \`agent/issue-${item.n}\` before you decide.`,
    "Read the issue and as much of the code as you need to decide one of:",
    `- ready: two implementer sessions (at most ${splitBound(budgets)} tokens of context) can implement and test it. Write \`plan\`: at most 15 lines naming the files and approach you found. A spec writer turns it into the full spec next.`,
    "- needs-info: a competent engineer could not start without answers. Ask at most 5 specific questions. If earlier questions were answered in the comments, use the answers.",
    splitLine(item.depth),
    "- reject: not suitable for an agent (design debate, production incident, needs production access, not a code change). Explain in `reason`. Issues that change CI workflows, auth, dependencies or migrations are suitable.",
    "Leave unused fields as empty strings or arrays.",
  ];
  return {
    kind: "session",
    name: "triage",
    agent: TRIAGE_AGENT,
    model: models.triage,
    schema: TRIAGE_SCHEMA,
    budgetRole: "triage",
    tokenBudget: sessionBudget(budgets, "triage"),
    attempt: item.attempt,
    task: preamble(cfg, item, "triage").concat(lines).join("\n"),
  };
}

// The comment triage posts on the issue for `decision`, or null for
// questions, which the ask op posts.
function announcement(decision: TriageDecision, reason: string): string | null {
  switch (decision) {
    case "ready":
      return `Taking this issue. ${reason} A spec follows.`;
    case "split":
      return `Taking this issue. ${reason} A spec follows, which may split it.`;
    case "reject":
      return `This issue isn't one the pipeline should take on: ${reason}`;
    case "needs-info":
      return null;
    default: {
      const unhandled: never = decision;
      return unhandled;
    }
  }
}

// The stop reason for a run past `maxTriages`.
function limitReason(maxTriages: number): string {
  return `triage ran ${maxTriages} times without reaching a decision the pipeline can act on`;
}

// The event-log line for `reply`, which the pipeline reads as `decision`.
function triageEvent(reply: TriageReply, decision: TriageDecision): string {
  let event: string = reply.decision;
  if (decision === "split") {
    event = "split-suggested";
  }
  return `triage: ${event} - ${reply.reason}`;
}

// The event-log line for the draft PR: opened, or the op's error.
function prEvent(pr: number | null, error: unknown): string {
  if (pr !== null) {
    return `opened draft PR #${pr}`;
  }
  return `could not open the draft PR yet: ${clip(String(error), PR_ERROR_LIMIT)}`;
}

// The plan as the state keeps it.
function keptPlan(plan: string): string {
  return clip(plan, PLAN_LIMIT);
}

export type { TriageItem, TriageSettings };
export {
  announcement,
  keptPlan,
  limitReason,
  prEvent,
  REJECTED,
  TRIAGE_FAILED,
  triageEvent,
  triageSession,
};
