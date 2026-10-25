// Sync: rebases revision R onto exactly target T when R doesn't contain T,
// before or after Harden. Its output is new code, which needs a fresh
// Harden. A text conflict stops the rebase in the action's checkout for one
// resolver session; the finish op continues, retains or rejects it. An
// interrupted run is settled read-only (ops/sync-task.ts `sync-reconcile`).

import { z } from "zod";
import type { Config } from "../config.ts";
import type {
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  Readiness,
  SessionResult,
  TaskView,
} from "../domain.ts";
import {
  currentBinding,
  implemented,
  runReadiness,
  unsettledRun,
  waiting,
} from "./chain.ts";
import { EFFECT_REPLY, effectEnd, recoverEnd } from "./effect.ts";
import { messageOf } from "./message.ts";
import type { TaskModule } from "./module.ts";
import { ended, notCurrent, notWritable } from "./module.ts";
import { WRITER_REPLY } from "./replies.ts";
import { sensed } from "./sensing.ts";
import { sessionTask } from "./session-task.ts";
import type { TaskEvidence } from "./view.ts";

const CONFLICT = z.looseObject({
  conflict: z.literal(true),
  conflicts: z.array(z.string()),
});

function blocked(view: TaskView): string | null {
  if (view.revision === null) {
    return "the work item has no code yet";
  }
  if (!implemented(view)) {
    return "Implement has not passed the current requirements";
  }
  if (view.containsTarget) {
    return `the revision already contains target ${view.target.commit}`;
  }
  return null;
}

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, "result");
  if (shared !== undefined) {
    return shared;
  }
  const open = unsettledRun(view, "sync");
  if (open !== undefined) {
    return runReadiness(view, open.binding, true);
  }
  const binding = currentBinding(view, "sync");
  const why = blocked(view);
  if (why !== null || binding === null) {
    return waiting(why ?? "the work item has no code yet");
  }
  return runReadiness(view, binding, true);
}

function prerequisite(
  cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
): string | null {
  return (
    notCurrent(evidence, binding) ??
    blocked(evidence.view) ??
    notWritable(cfg, evidence.view.workItem.number)
  );
}

type Finish =
  | { retainConflict: true; reason: string }
  | { cannotFix: true; reason: string }
  | Record<string, never>;

// How the finish op ends the stopped rebase after the resolver session.
function finishOf(session: SessionResult): Finish {
  if (!session.ok) {
    return { retainConflict: true, reason: "the resolver session ended" };
  }
  const reply = WRITER_REPLY.parse(session.reply);
  if (reply.outcome === "done") {
    return {};
  }
  return { cannotFix: true, reason: reply.reason };
}

// One resolver session on the stopped rebase, then the finish op.
async function resolved(
  ctx: ActionContext,
  conflicts: readonly string[],
): Promise<ActionEnd> {
  await ctx.prepare();
  await ctx.boundary("session");
  const session = await ctx.session({
    agent: "issue-pipeline-developer",
    model: ctx.cfg.models.developer,
    task: sessionTask(ctx, "conflict-resolution", [
      "## Conflicts",
      "",
      ...conflicts.map((file) => `- \`${file}\``),
      "",
    ]),
    schema: WRITER_REPLY,
    commits: true,
    phase: "sync",
  });
  await ctx.boundary("finish");
  return await effectEnd(ctx, "sync-task-finish", finishOf(session));
}

async function act(ctx: ActionContext): Promise<ActionEnd> {
  let raw: unknown;
  try {
    raw = await ctx.op("sync-task", {
      number: ctx.workItem.number,
      binding: ctx.binding,
      run: { id: ctx.run.id },
    });
  } catch (error) {
    return ended("unknown", `sync-task is uncertain: ${messageOf(error)}`);
  }
  const conflict = CONFLICT.safeParse(raw);
  if (conflict.success) {
    const { conflicts } = conflict.data;
    await ctx.checkpoint({ sync: "conflict", conflicts });
    return await resolved(ctx, conflicts);
  }
  const reply = EFFECT_REPLY.safeParse(raw);
  if (!reply.success) {
    return ended("unknown", "sync-task's reply is not readable");
  }
  return endOf(reply.data);
}

function endOf(reply: z.infer<typeof EFFECT_REPLY>): ActionEnd {
  if (reply.produced !== undefined) {
    return ended(reply.verdict, reply.reason, reply.produced);
  }
  return ended(reply.verdict, reply.reason);
}

const sync: TaskModule = {
  definition: {
    id: "sync",
    role: "developer",
    access: "writer",
    sensors: ["result", "stop"],
    resources: ["model-session", "test-slot"],
    match,
    act,
    recover: async (ctx: ActionContext) =>
      await recoverEnd(ctx, "sync-reconcile"),
  },
  prerequisite,
  ownsResult: true,
  writesCode: true,
};

export { sync };
