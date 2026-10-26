// The writer tasks' Developer sessions, and Implement's action: a writing
// session, then a fresh hardening session, then the push of the item's
// branch and its PR through the ops child. Every session is its own pi
// process that commits in the action's checkout; none reads another's
// conversation. A session's reply grants nothing: the result op checks the
// produced head against the branch again before it records a pass.

import { z } from "zod";
import type {
  ActionContext,
  ActionEnd,
  SessionResult,
  SessionSpec,
} from "../domain.ts";
import { SHA } from "../domain.ts";
import { messageOf } from "./message.ts";
import { ended } from "./module.ts";
import { WRITER_REPLY } from "./replies.ts";
import type { SessionKind } from "./session-task.ts";
import { sessionTask } from "./session-task.ts";

const PUSHED = z.looseObject({ headSha: SHA });
const OPENED = z.looseObject({ pr: z.number().int().positive() });

// What a writer session ended with: its summary, or why it didn't finish.
type Written = { ok: true; summary: string } | { ok: false; reason: string };

// Runs one committing Developer session: its task names `kind` and adds
// `extra`; `phase` picks its prompt page, and, with schema, the session's
// reply shape.
async function developerSession(
  ctx: ActionContext,
  kind: SessionKind,
  setup: {
    phase: SessionSpec["phase"];
    schema: z.ZodType;
    extra: readonly string[];
  },
): Promise<SessionResult> {
  const spec: SessionSpec = {
    agent: "issue-pipeline-developer",
    model: ctx.cfg.models.developer,
    task: sessionTask(ctx, kind, setup.extra),
    schema: setup.schema,
    commits: true,
  };
  if (setup.phase !== undefined) {
    spec.phase = setup.phase;
  }
  return await ctx.session(spec);
}

async function written(
  ctx: ActionContext,
  kind: "development" | "hardening",
  extra: readonly string[],
): Promise<Written> {
  let phase: SessionSpec["phase"];
  if (kind === "hardening") {
    phase = "hardening";
  }
  const session = await developerSession(ctx, kind, {
    phase,
    schema: WRITER_REPLY,
    extra,
  });
  if (!session.ok) {
    return {
      ok: false,
      reason: `the ${kind} session failed: ${session.error}`,
    };
  }
  const reply = WRITER_REPLY.parse(session.reply);
  if (reply.outcome === "cannot") {
    return {
      ok: false,
      reason: `the ${kind} session could not finish: ${reply.reason}`,
    };
  }
  return { ok: true, summary: reply.summary };
}

// The hardening session's own facts: it starts fresh, from the branch as
// the writing session left it.
function hardeningFacts(ctx: ActionContext): string[] {
  return [
    "## Hardening",
    "",
    "This is a fresh session. The writing session's conversation is not given to you; judge the code on the branch.",
    "",
    `The change against the base: \`git -C ${ctx.checkout.repo} diff origin/${ctx.cfg.baseBranch}...HEAD\``,
    "",
  ];
}

async function pushed(ctx: ActionContext): Promise<string> {
  const { number } = ctx.workItem;
  const { headSha } = PUSHED.parse(await ctx.op("push", { number }));
  OPENED.parse(await ctx.op("open-task-pr", { number }));
  return headSha;
}

// Implement's action: the writing session, the fresh hardening session,
// then the branch push and the development account's ready PR.
async function implementAction(ctx: ActionContext): Promise<ActionEnd> {
  await ctx.prepare();
  await ctx.boundary("session");
  const writing = await written(ctx, "development", []);
  if (!writing.ok) {
    return ended("failed", writing.reason);
  }
  await ctx.checkpoint({ session: "development", summary: writing.summary });
  await ctx.boundary("session");
  const hardening = await written(ctx, "hardening", hardeningFacts(ctx));
  if (!hardening.ok) {
    return ended("failed", hardening.reason);
  }
  await ctx.checkpoint({ session: "hardening", summary: hardening.summary });
  await ctx.boundary("push");
  try {
    return ended("passed", writing.summary, await pushed(ctx));
  } catch (error) {
    return ended("unknown", `the push or PR is uncertain: ${messageOf(error)}`);
  }
}

export { developerSession, implementAction };
