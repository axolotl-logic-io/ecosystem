// Review Security: the Gatekeeper's one read-only security session on
// revision R at target T, once Harden and Integrate attest R on T. A finding
// refuses the subject, its code and trusted inputs, which fences every
// writer of that subject for good (write-authority.ts). A pass needs the
// session's checkout to be exactly R, clean, before and after it.

import type { Config } from "../config.ts";
import type {
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  Readiness,
  TaskView,
} from "../domain.ts";
import { isRevisionBinding } from "../domain.ts";
import { gitIn } from "../git-state.ts";
import { currentBinding, passedFor, runReadiness, waiting } from "./chain.ts";
import type { TaskModule } from "./module.ts";
import { ended, notCurrent } from "./module.ts";
import { SECURITY_REVIEW_REPLY } from "./replies.ts";
import { sensed } from "./sensing.ts";
import { sessionTask } from "./session-task.ts";
import type { TaskEvidence } from "./view.ts";

function blocked(view: TaskView): string | null {
  const { revision, target } = view;
  if (revision === null) {
    return "the work item has no code yet";
  }
  for (const task of ["harden", "integrate"] as const) {
    if (passedFor(view, task, revision, target) === undefined) {
      return `${task} has not passed this revision and target`;
    }
  }
  return null;
}

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, "result");
  if (shared !== undefined) {
    return shared;
  }
  const binding = currentBinding(view, "review-security");
  const why = blocked(view);
  if (why !== null || binding === null) {
    return waiting(why ?? "the work item has no code yet");
  }
  return runReadiness(view, binding, false);
}

function prerequisite(
  _cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
): string | null {
  return notCurrent(evidence, binding) ?? blocked(evidence.view);
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

async function act(ctx: ActionContext): Promise<ActionEnd> {
  const before = notExactly(ctx);
  if (before !== null) {
    return ended("failed", `the security session reviewed nothing: ${before}`);
  }
  await ctx.boundary("session");
  const session = await ctx.session({
    agent: "issue-pipeline-reviewer",
    model: ctx.cfg.models.reviewer,
    task: sessionTask(ctx, "security-review"),
    schema: SECURITY_REVIEW_REPLY,
    commits: false,
    phase: "security-review",
  });
  if (!session.ok) {
    return ended(
      "failed",
      `the security session judged nothing: ${session.error}`,
    );
  }
  const reply = SECURITY_REVIEW_REPLY.parse(session.reply);
  const after = notExactly(ctx);
  if (reply.finding === null && after !== null) {
    return ended(
      "failed",
      `the read-only security session changed what it reviewed: ${after}`,
    );
  }
  if (reply.finding === null) {
    return ended("passed", reply.summary);
  }
  return ended("refused", `${reply.finding.category}: ${reply.finding.reason}`);
}

const reviewSecurity: TaskModule = {
  definition: {
    id: "review-security",
    role: "gatekeeper",
    access: "reader",
    sensors: ["result", "stop"],
    resources: ["model-session"],
    match,
    act,
  },
  prerequisite,
  ownsResult: false,
  writesCode: false,
};

export { reviewSecurity };
