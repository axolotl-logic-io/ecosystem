// Fix: the Developer's answer to a change that didn't pass review. It binds a
// revision, the item PR's head R, and becomes ready for exactly that head
// when one of these wakes it:
//
//   - Verify's latest result for R refused: its request for changes;
//   - a qualified person's accepted review requesting changes on R;
//   - Land's latest result for R refused for a conflict with the base.
//
// In one run its ops merge target T into R's branch with a merge commit,
// never a rebase; one Developer session (phase `fix`) resolves any conflict
// and answers every blocking review comment with code; then the branch is
// pushed through the development account, each blocking thread gets a reply,
// and a draft PR is marked ready (ops/fix-task.ts). At most VERIFY_FIX_ROUNDS
// of an item's Fix rounds may be Verify's; a further request for changes from
// Verify holds the item for a person. An unsettled run is reconciled
// read-only and never pushed again.

import { z } from "zod";
import type { Config } from "../config.ts";
import type {
  ActionCause,
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  Readiness,
  TaskResult,
  TaskView,
} from "../domain.ts";
import {
  isRevisionBinding,
  LAND_EVIDENCE,
  VERIFY_FIX_ROUNDS,
} from "../domain.ts";
import {
  currentBinding,
  held,
  runReadiness,
  unsettledRun,
  verifyFixRounds,
} from "./chain.ts";
import { EFFECT_REPLY, effectEnd, recoverEnd } from "./effect.ts";
import { messageOf } from "./message.ts";
import type { TaskModule } from "./module.ts";
import { ended, notCurrent, notWritable } from "./module.ts";
import { FIX_REPLY } from "./replies.ts";
import { sensed } from "./sensing.ts";
import type { TaskEvidence } from "./view.ts";
import { developerSession } from "./writer-session.ts";

// What woke a Fix: Verify's request for changes, a person's, or Land's
// conflict.
type FixCause = "verify" | "review" | "conflict";

const POSITIVE = z.number().int().positive();
// What fix-merge found to answer, when the run goes on to its session.
const STARTED = z.looseObject({
  fix: z.looseObject({
    pr: POSITIVE,
    base: z.string().min(1),
    conflicts: z.array(z.string()),
    requests: z.array(
      z.looseObject({ id: POSITIVE, author: z.string(), body: z.string() }),
    ),
    threads: z.array(
      z.looseObject({
        id: POSITIVE,
        path: z.string(),
        line: POSITIVE.nullable(),
        author: z.string(),
        body: z.string(),
      }),
    ),
    session: z.boolean(),
  }),
});

type Started = z.infer<typeof STARTED>["fix"];

// What fix-finish takes from the session: why it didn't finish, or its
// summary and its answer to each blocking comment.
type Finish =
  | Record<string, never>
  | { failed: string }
  | { summary: string; replies: { comment: number; reply: string }[] };

// The latest determined result of `task` bound to head `code`.
function latestOn(
  view: TaskView,
  task: "verify" | "land",
  code: string,
): TaskResult | undefined {
  return view.results
    .filter(
      (result) =>
        result.binding.task === task &&
        isRevisionBinding(result.binding) &&
        result.binding.revision.code === code &&
        result.verdict !== "unknown",
    )
    .at(-1);
}

function conflictOn(result: TaskResult, code: string): boolean {
  const evidence = LAND_EVIDENCE.safeParse(result.receipt.evidence);
  return (
    evidence.success &&
    evidence.data.outcome === "conflict" &&
    evidence.data.head === code
  );
}

// What result `recordId` wakes Fix for on head `code`: Verify's request for
// changes, or Land's conflict, each only while it is the head's latest
// result of its task.
function resultCause(
  view: TaskView,
  recordId: number,
  code: string,
): "verify" | "conflict" | null {
  const verify = latestOn(view, "verify", code);
  if (verify?.recordId === recordId && verify.verdict === "refused") {
    return "verify";
  }
  const land = latestOn(view, "land", code);
  if (
    land?.recordId === recordId &&
    land.verdict === "refused" &&
    conflictOn(land, code)
  ) {
    return "conflict";
  }
  return null;
}

function signalCause(
  signal: QualifiedSignal,
  view: TaskView,
  code: string,
): FixCause | null {
  if (signal.kind === "result") {
    return resultCause(view, signal.recordId, code);
  }
  if (
    signal.kind === "review" &&
    signal.review.state === "CHANGES_REQUESTED" &&
    signal.review.commit === code
  ) {
    return "review";
  }
  return null;
}

function spent(rounds: number): string {
  return `Verify requested changes after ${String(rounds)} Fix rounds of its own; the item holds for a person`;
}

// What an action's recorded `cause` still wakes Fix for on head `code`, or
// why it no longer does. A person's review is requalified by the op guard
// and checked against GitHub by the op; only a result is judged here. The
// view counts the action's own attempt among the rounds.
function standingCause(
  view: TaskView,
  cause: ActionCause,
  code: string,
): { cause: FixCause } | { reason: string } {
  if (cause.signal !== `result:${String(cause.recordId)}`) {
    return { cause: "review" };
  }
  const found = resultCause(view, cause.recordId, code);
  if (found === null) {
    return {
      reason: `${cause.signal} is not the latest request for changes or conflict on ${code}`,
    };
  }
  const rounds = verifyFixRounds(view);
  if (found === "verify" && rounds > VERIFY_FIX_ROUNDS) {
    return { reason: spent(rounds - 1) };
  }
  return { cause: found };
}

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, signal.kind);
  if (shared !== undefined) {
    return shared;
  }
  const open = unsettledRun(view, "fix");
  if (open !== undefined) {
    return runReadiness(view, open.binding, true);
  }
  const binding = currentBinding(view, "fix");
  if (binding === null) {
    return null;
  }
  const cause = signalCause(signal, view, binding.revision.code);
  if (cause === null) {
    return null;
  }
  const rounds = verifyFixRounds(view);
  if (cause === "verify" && rounds >= VERIFY_FIX_ROUNDS) {
    return held(spent(rounds));
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
    notWritable(cfg, evidence.view.workItem.number)
  );
}

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => `  > ${line}`)
    .join("\n");
}

// The Fix session's facts: the conflicts to resolve, the requests for
// changes and the blocking comments to answer.
function fixFacts(ctx: ActionContext, found: Started): string[] {
  const lines = [`## What to fix on PR #${String(found.pr)}`, ""];
  if (found.conflicts.length > 0) {
    lines.push(
      "### Conflicts",
      "",
      `Fix merged \`${found.base}\` into the branch, and the merge stopped on these files:`,
      "",
      ...bullets(found.conflicts.map((file) => `\`${file}\``)),
      "",
      `Resolve each file, stage it with \`git -C ${ctx.checkout.repo} add -- <file>\`, and conclude the merge with one \`pipeline_commit\` that names no path, before any other change.`,
      "",
    );
  }
  if (found.requests.length > 0) {
    lines.push("### Requests for changes", "");
    for (const request of found.requests) {
      lines.push(
        `- Review ${String(request.id)} by @${request.author}:`,
        quoted(request.body || "(no body)"),
      );
    }
    lines.push("");
  }
  if (found.threads.length > 0) {
    lines.push("### Blocking comments", "");
    for (const thread of found.threads) {
      lines.push(
        `- Comment ${String(thread.id)} by @${thread.author} on \`${thread.path}\` line ${String(thread.line ?? "none")}:`,
        quoted(thread.body),
      );
    }
    lines.push(
      "",
      "Reply with one entry in `replies` for each blocking comment, by its id.",
      "",
    );
  }
  return lines;
}

// The Fix session over what fix-merge found, and what fix-finish should do
// with its end.
async function answered(ctx: ActionContext, found: Started): Promise<Finish> {
  await ctx.prepare();
  await ctx.boundary("session");
  const session = await developerSession(ctx, "fix", {
    phase: "fix",
    schema: FIX_REPLY,
    extra: fixFacts(ctx, found),
  });
  if (!session.ok) {
    return { failed: `the Fix session failed: ${session.error}` };
  }
  const reply = FIX_REPLY.parse(session.reply);
  if (reply.outcome === "cannot") {
    return { failed: `the Fix session could not finish: ${reply.reason}` };
  }
  await ctx.checkpoint({ session: "fix", summary: reply.summary });
  return { summary: reply.summary, replies: reply.replies };
}

function endOf(reply: z.infer<typeof EFFECT_REPLY>): ActionEnd {
  if (reply.produced !== undefined) {
    return ended(reply.verdict, reply.reason, reply.produced);
  }
  return ended(reply.verdict, reply.reason);
}

async function act(ctx: ActionContext): Promise<ActionEnd> {
  let raw: unknown;
  try {
    raw = await ctx.op("fix-merge", {
      number: ctx.workItem.number,
      binding: ctx.binding,
      run: { id: ctx.run.id },
    });
  } catch (error) {
    return ended("unknown", `fix-merge is uncertain: ${messageOf(error)}`);
  }
  const started = STARTED.safeParse(raw);
  if (!started.success) {
    const reply = EFFECT_REPLY.safeParse(raw);
    if (!reply.success) {
      return ended("unknown", "fix-merge's reply is not readable");
    }
    return endOf(reply.data);
  }
  const found = started.data.fix;
  let finish: Finish = {};
  if (found.session) {
    finish = await answered(ctx, found);
  }
  await ctx.boundary("finish");
  return await effectEnd(ctx, "fix-finish", finish);
}

const fix: TaskModule = {
  definition: {
    id: "fix",
    role: "developer",
    access: "writer",
    sensors: ["result", "review", "stop"],
    resources: ["model-session", "test-slot"],
    match,
    act,
    recover: (ctx: ActionContext): Promise<ActionEnd> =>
      recoverEnd(ctx, "fix-reconcile"),
  },
  prerequisite,
  ownsResult: true,
  writesCode: true,
};

export type { FixCause };
export { fix, standingCause };
