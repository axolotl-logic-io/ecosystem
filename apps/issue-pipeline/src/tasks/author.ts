// Author: the Developer's Gherkin requirements for the issue, requested by
// `start:author` for the issue's current trusted requirements. Like
// Implement, any attempt of those requirements prevents another; neither task
// waits for the other. Its action is one read-only Author session, whose
// Gherkin, or questions that only the issue's author can answer, its op posts
// on the issue as the pipeline's author comment (ops/author-post.ts). That
// comment never counts toward the trusted requirements. Gherkin passes;
// questions refuse, so the issue waits for its author's answer and a new
// start.

import type { Config } from "../config.ts";
import type {
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  Readiness,
  TaskView,
} from "../domain.ts";
import { effectEnd } from "./effect.ts";
import type { TaskModule } from "./module.ts";
import { ended } from "./module.ts";
import { AUTHOR_REPLY } from "./replies.ts";
import { startReadiness, startUnmet } from "./requirements-start.ts";
import { sessionTask } from "./session-task.ts";
import type { TaskEvidence } from "./view.ts";

// The Author session's facts beside the issue file: where the current
// Gherkin is, and the reply's two shapes.
const AUTHOR_FACTS: readonly string[] = [
  "## Current Gherkin",
  "",
  "The issue's current Gherkin, if it has one, is the comment of the pipeline's author agent in the issue file.",
  "",
  "## Reply",
  "",
  "- `gherkin`: the behaviour as one Feature in `gherkin`, your calls in `assumptions`, and in `changed` whether the behaviour differs from the issue's current Gherkin (true when it has none).",
  "- `needs-info`: up to five `questions` that only the issue's author can answer.",
  "",
];

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  return startReadiness(signal, view, "author");
}

function prerequisite(
  _cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
): string | null {
  return startUnmet(evidence.view, binding, "author");
}

async function act(ctx: ActionContext): Promise<ActionEnd> {
  await ctx.boundary("session");
  const session = await ctx.session({
    agent: "issue-pipeline-author",
    model: ctx.cfg.models.author,
    task: sessionTask(ctx, "authoring", AUTHOR_FACTS),
    schema: AUTHOR_REPLY,
    commits: false,
  });
  if (!session.ok) {
    return ended("failed", `the Author session failed: ${session.error}`);
  }
  const reply = AUTHOR_REPLY.parse(session.reply);
  await ctx.boundary("post");
  return await effectEnd(ctx, "author-post", { reply });
}

const author: TaskModule = {
  definition: {
    id: "author",
    role: "developer",
    access: "writer",
    sensors: ["start", "stop"],
    resources: ["model-session"],
    match,
    act,
  },
  prerequisite,
  ownsResult: false,
  writesCode: false,
};

export { author };
