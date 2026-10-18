// The `fix` entry's sessions (#418; the wiki's Pipeline-Roles-Implementor,
// "Fix (the fixer's half)", and Pipeline-Roles-Reviewer, "Re-review"): the
// fixer, with a continuation from its handoff in the same round, and each
// lens's re-reviewer, with that lens's open findings and the fix's diff.
// Their tasks and schemas are today's fix and rereview stages'. Pure.

import { sessionBudget } from "../../workflow/budget.ts";
import { openFindings } from "../../workflow/findings.ts";
import type { Lens } from "../../workflow/lenses.ts";
import {
  FIX_SCHEMA,
  REREVIEW_SCHEMA,
  REREVIEW_SEC_SCHEMA,
} from "../../workflow/review-schemas.ts";
import type { JsonSchema } from "../../workflow/schemas.ts";
import type {
  TaskContext,
  TaskItem,
} from "../../workflow/stages/review-task-types.ts";
import { fixTask, rereviewTask } from "../../workflow/stages/review-text.ts";
import type { Finding } from "../../workflow/types.ts";
import type { SessionEffect } from "../machine.ts";
import { findingsOf } from "./fix-data.ts";
import type { ImplData } from "./locate.ts";
import { IMPL_AGENT } from "./locate.ts";

// The agent every re-reviewer runs as, and the fixer's role name.
const REREVIEW_AGENT = "issue-pipeline-reader";
const FIXER_ROLE = "fixer";

function taskContext(data: ImplData): TaskContext {
  const { cfg, budgets } = data.settings;
  return { cfg, budgets, committer: "pipeline_commit" };
}

function taskItem(data: ImplData): TaskItem {
  const { spec = null, specFile = null, resolvedHistory } = data;
  return {
    n: data.issue,
    paths: data.settings.paths,
    st: { spec, specFile, resolvedHistory },
  };
}

// The open findings of `data`, as the stages read them.
function openOf(data: ImplData): Finding[] {
  return openFindings({ st: { findings: findingsOf(data.findings) } });
}

// The open findings `lens` raised.
function lensFindings(data: ImplData, lens: Lens): Finding[] {
  return openOf(data).filter((finding) => finding.lenses.includes(lens));
}

// The round's fixer, `fix-r<round>`, or `fix-r<round>-c<k>` for the issue's
// kth fixer continuation, which follows a fixer's handoff.
function fixerSession(data: ImplData): SessionEffect {
  const { budgets, models } = data.settings;
  const continuation = data.fixReply?.status === "handoff";
  let name = `fix-r${data.fixRounds}`;
  if (continuation) {
    name += `-c${data.fixContinuations}`;
  }
  const job = { round: data.fixRounds, open: openOf(data), continuation };
  return {
    kind: "session",
    name,
    agent: IMPL_AGENT,
    model: models.fixer,
    schema: FIX_SCHEMA,
    budgetRole: FIXER_ROLE,
    tokenBudget: sessionBudget(budgets, FIXER_ROLE),
    attempt: data.fixRounds,
    task: fixTask(taskContext(data), taskItem(data), job),
  };
}

function schemaOf(lens: Lens): JsonSchema {
  if (lens === "security") {
    return REREVIEW_SEC_SCHEMA;
  }
  return REREVIEW_SCHEMA;
}

// The re-reviewer of `lens` in the round, on the fix's diff.
function rereviewerSession(lens: Lens): (data: ImplData) => SessionEffect {
  return (data: ImplData): SessionEffect => {
    const { budgets, models } = data.settings;
    const scope = {
      lens,
      diffPath: data.diffPath ?? "",
      findings: lensFindings(data, lens),
    };
    return {
      kind: "session",
      name: `rereview-${lens}-r${data.fixRounds}`,
      agent: REREVIEW_AGENT,
      model: models[lens],
      schema: schemaOf(lens),
      budgetRole: "rereviewer",
      tokenBudget: sessionBudget(budgets, "rereviewer"),
      attempt: data.fixRounds,
      task: rereviewTask(taskContext(data), taskItem(data), scope),
    };
  };
}

export {
  FIXER_ROLE,
  fixerSession,
  lensFindings,
  openOf,
  REREVIEW_AGENT,
  rereviewerSession,
};
