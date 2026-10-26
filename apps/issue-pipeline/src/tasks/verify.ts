// Verify: the Gatekeeper's check of one exact PR head, reported as a GitHub
// review the landing account submits against that head's commit. It runs the
// repository's full checks, the required CI and the Security review of the
// head; it approves when it finds nothing or only nits and requests changes
// otherwise, and a Security finding always blocks. It binds a revision: the
// item PR's head. It becomes ready for a head with no Verify result, once the
// Implement or Fix result that produced that head wakes it, or for a
// `start:verify` naming exactly that head, which also retries a run of that
// head that failed to judge it. Its result mirrors its review (domain.ts
// VERIFY_EVIDENCE): passed for an approval, refused for a request for
// changes, failed when it could not judge. It never writes code.
//
// Its action is one read-only Reviewer session on the action's checkout,
// which must be exactly the head, clean, before and after it; then its
// effect op (ops/verify-task.ts) runs the checks and reads CI, submits the
// review and records the verdict. An unsettled run is reconciled read-only
// from the PR's reviews and never reviewed twice.

import { z } from "zod";
import type { Config } from "../config.ts";
import type {
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  Readiness,
  RevisionBinding,
  TaskView,
} from "../domain.ts";
import { isRevisionBinding, sameBinding } from "../domain.ts";
import { gitIn } from "../git-state.ts";
import { ciUnsettled } from "../ops/verify-ci.ts";
import {
  currentBinding,
  held,
  latestRun,
  runReadiness,
  unsettledRun,
  waiting,
} from "./chain.ts";
import { effectEnd, recoverEnd } from "./effect.ts";
import type { TaskModule } from "./module.ts";
import { notCurrent } from "./module.ts";
import { TASK_ATTEMPTS } from "./records.ts";
import { sensed } from "./sensing.ts";
import { sessionTask } from "./session-task.ts";
import type { TaskEvidence } from "./view.ts";

const MAX_FINDING = 4000;

// One finding of the review session. One with a `path` and a `line` is
// about those lines; any other is about the change as a whole. A nit
// changes no behavior, safety or maintainability; a Security finding
// blocks whatever its severity.
const FINDING = z.strictObject({
  path: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  body: z.string().min(1).max(MAX_FINDING),
  severity: z.enum(["blocking", "nit"]),
  security: z.boolean(),
});

// The reply of Verify's one read-only session: what it examined, and every
// finding. The reply grants nothing: the effect op decides the review from
// it, the checks and the required CI.
const VERIFY_REPLY = z.strictObject({
  summary: z.string().min(1).max(MAX_FINDING),
  findings: z.array(FINDING),
});

type VerifyFinding = z.infer<typeof FINDING>;
type VerifyReply = z.infer<typeof VERIFY_REPLY>;

// Whether `signal` is the passed Implement or Fix result that produced the
// view's current head.
function producedHead(
  signal: QualifiedSignal,
  view: TaskView,
  binding: RevisionBinding,
): boolean {
  if (signal.kind !== "result") {
    return false;
  }
  const producer = view.results.find(
    (result) => result.recordId === signal.recordId,
  );
  return (
    producer !== undefined &&
    producer.verdict === "passed" &&
    (producer.binding.task === "implement" ||
      producer.binding.task === "fix") &&
    producer.receipt.produced?.code === binding.revision.code
  );
}

// The readiness a person's `start:verify` gives `binding`: a new attempt
// after a run that failed to judge the head, within the binding's attempt
// budget, since the person asked for that head again; otherwise the
// binding's own readiness. A start never repeats a review: a passed or
// refused run stands.
function startReadiness(
  signal: QualifiedSignal,
  view: TaskView,
  binding: RevisionBinding,
): Readiness {
  const latest = latestRun(view, binding);
  if (latest?.verdict !== "failed" || latest.cause.signal === signal.id) {
    return runReadiness(view, binding, true);
  }
  const runs = new Set(
    view.results
      .filter((result) => result.binding.task === "verify")
      .filter((result) => sameBinding(result.binding, binding))
      .map((result) => result.run.id),
  );
  if (runs.size >= TASK_ATTEMPTS) {
    return held(
      `Verify ran ${binding.revision.code} ${String(runs.size)} times, its binding's ${String(TASK_ATTEMPTS)} attempts`,
    );
  }
  return { state: "ready", binding };
}

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, signal.kind);
  if (shared !== undefined) {
    return shared;
  }
  const open = unsettledRun(view, "verify");
  if (open !== undefined) {
    return runReadiness(view, open.binding, true);
  }
  const binding = currentBinding(view, "verify");
  if (signal.kind === "start") {
    if (signal.task !== "verify") {
      return null;
    }
    if (binding === null || signal.head !== binding.revision.code) {
      return waiting(
        `start ${signal.id} names head ${signal.head}, which is no longer the PR's head; a new start is needed`,
      );
    }
    return startReadiness(signal, view, binding);
  }
  if (binding === null || !producedHead(signal, view, binding)) {
    return null;
  }
  return runReadiness(view, binding, true);
}

function prerequisite(
  cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
): string | null {
  const stale = notCurrent(evidence, binding);
  if (stale !== null || !isRevisionBinding(binding)) {
    return stale ?? "the binding is not a revision binding";
  }
  return ciUnsettled(cfg, binding.workItem.number, binding.revision.code);
}

// Why the checkout is not exactly the bound code, committed and unchanged,
// or null. Reader tools declare no write, but nothing on disk enforces it.
function notExactly(ctx: ActionContext): string | null {
  const { binding, checkout } = ctx;
  if (!isRevisionBinding(binding)) {
    return "the binding is not a revision binding";
  }
  const head = gitIn(checkout.repo, ["rev-parse", "HEAD"]).trim();
  if (head !== binding.revision.code) {
    return `its checkout's head is ${head}, not ${binding.revision.code}`;
  }
  const changed = gitIn(checkout.repo, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]).trim();
  if (changed !== "") {
    return `its checkout differs from ${head}: ${changed.split("\n").join("; ")}`;
  }
  return null;
}

// A run that judged nothing records why, in Verify's own op, since only
// its ops record its determined verdicts.
function unjudged(ctx: ActionContext, reason: string): Promise<ActionEnd> {
  return effectEnd(ctx, "verify-unjudged", { reason });
}

function reviewFacts(ctx: ActionContext): string[] {
  const { binding } = ctx;
  if (!isRevisionBinding(binding)) {
    return [];
  }
  return [
    "## The change under review",
    "",
    `The PR's whole contribution is \`git diff ${binding.target.commit}...${binding.revision.code}\` in the checkout.`,
    "",
  ];
}

async function act(ctx: ActionContext): Promise<ActionEnd> {
  const before = notExactly(ctx);
  if (before !== null) {
    return unjudged(ctx, `the review session reviewed nothing: ${before}`);
  }
  await ctx.prepare();
  const prepared = notExactly(ctx);
  if (prepared !== null) {
    return unjudged(
      ctx,
      `setup changed what the review session would review: ${prepared}`,
    );
  }
  await ctx.boundary("session");
  const session = await ctx.session({
    agent: "issue-pipeline-reviewer",
    model: ctx.cfg.models.reviewer,
    task: sessionTask(ctx, "security-review", reviewFacts(ctx)),
    schema: VERIFY_REPLY,
    commits: false,
    phase: "security-review",
  });
  if (!session.ok) {
    return unjudged(ctx, `the review session judged nothing: ${session.error}`);
  }
  const reply = VERIFY_REPLY.parse(session.reply);
  const after = notExactly(ctx);
  if (after !== null) {
    return unjudged(
      ctx,
      `the read-only review session changed what it reviewed: ${after}`,
    );
  }
  await ctx.boundary("review");
  return effectEnd(ctx, "verify-task", { reply });
}

const verify: TaskModule = {
  definition: {
    id: "verify",
    role: "gatekeeper",
    access: "reader",
    sensors: ["start", "result", "stop"],
    resources: ["model-session", "test-slot"],
    match,
    act,
    recover: (ctx: ActionContext): Promise<ActionEnd> =>
      recoverEnd(ctx, "verify-reconcile"),
  },
  prerequisite,
  ownsResult: true,
  writesCode: false,
};

export type { VerifyFinding, VerifyReply };
export { VERIFY_REPLY, verify };
