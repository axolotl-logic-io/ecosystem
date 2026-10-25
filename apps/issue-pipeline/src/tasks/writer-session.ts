// The writer tasks' shared action, Implement's and Harden's: one Developer
// session that commits in the action's checkout, then the push of the
// item's branch and its PR through the ops child. The session's reply
// grants nothing: the result op checks the produced head against the
// branch again before it records a pass.

import { z } from "zod";
import type { ActionContext, ActionEnd, SessionResult } from "../domain.ts";
import { SHA } from "../domain.ts";
import { messageOf } from "./message.ts";
import { ended } from "./module.ts";
import { WRITER_REPLY } from "./replies.ts";
import { sessionTask } from "./session-task.ts";

const PUSHED = z.looseObject({ headSha: SHA });
const OPENED = z.looseObject({ pr: z.number().int().positive() });

async function pushed(ctx: ActionContext): Promise<string> {
  const { number } = ctx.workItem;
  const { headSha } = PUSHED.parse(await ctx.op("push", { number }));
  OPENED.parse(await ctx.op("open-task-pr", { number }));
  return headSha;
}

async function writerAction(
  ctx: ActionContext,
  kind: "development" | "hardening",
): Promise<ActionEnd> {
  await ctx.boundary("session");
  const spec = {
    agent: "issue-pipeline-developer",
    model: ctx.cfg.models.developer,
    task: sessionTask(ctx, kind),
    schema: WRITER_REPLY,
    commits: true,
  } as const;
  let session: SessionResult;
  if (kind === "hardening") {
    session = await ctx.session({ ...spec, phase: "hardening" });
  } else {
    session = await ctx.session(spec);
  }
  if (!session.ok) {
    return ended("failed", `the Developer session failed: ${session.error}`);
  }
  const reply = WRITER_REPLY.parse(session.reply);
  if (reply.outcome === "cannot") {
    return ended("failed", `the Developer could not finish: ${reply.reason}`);
  }
  await ctx.checkpoint({ session: "done", summary: reply.summary });
  await ctx.boundary("push");
  try {
    return ended("passed", reply.summary, await pushed(ctx));
  } catch (error) {
    return ended("unknown", `the push or PR is uncertain: ${messageOf(error)}`);
  }
}

export { writerAction };
