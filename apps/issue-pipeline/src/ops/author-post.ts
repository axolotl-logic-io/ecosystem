// Author's op (tasks/author.ts). `author-post` posts this action's Author
// reply on the issue while its own attempt is unsettled and the trusted
// requirements it was bound to are still current: Gherkin as the issue's
// one keyed `gherkin` comment, questions as its one keyed
// `author-questions` comment, each edited in place when the Author writes
// it again. The landing account writes both, signed by the author role, so
// neither is a trusted input (issue-context.ts): posting changes no
// requirements digest and holds nothing back from Implement. It records
// nothing; the action's result does.

import { z } from "zod";
import type { Author } from "../comments.ts";
import { commentByKey } from "../comments.ts";
import type { Config } from "../config.ts";
import { parseRequest } from "../process.ts";
import { AUTHOR_REPLY } from "../tasks/replies.ts";
import type { EffectOutcome } from "./task-run.ts";
import { openRun } from "./task-run.ts";

const REQUEST = z.looseObject({ reply: AUTHOR_REPLY });
const GHERKIN_KEY = "gherkin";
const QUESTIONS_KEY = "author-questions";

type AuthorReply = z.infer<typeof AUTHOR_REPLY>;

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function assumptions(items: readonly string[]): string[] {
  if (items.length === 0) {
    return [];
  }
  return ["", "### Assumptions", "", ...bullets(items)];
}

function gherkinBody(
  reply: Extract<AuthorReply, { outcome: "gherkin" }>,
  requirements: string,
): string {
  return [
    "## Behaviour",
    "",
    "```gherkin",
    reply.gherkin.trim(),
    "```",
    ...assumptions(reply.assumptions),
    "",
    `<sub>Written for the trusted requirements ${requirements}. It doesn't count toward them; reply on the issue to change the behaviour.</sub>`,
  ].join("\n");
}

function questionsBody(questions: readonly string[]): string {
  return [
    "## Questions for the issue's author",
    "",
    "The Author can't write this issue's behaviour without these answers. Answer on the issue, then start Author again.",
    "",
    ...bullets(questions),
  ].join("\n");
}

function authorPost(cfg: Config, request: unknown): EffectOutcome {
  const open = openRun(cfg, request, "author", "author-post");
  const { reply } = parseRequest(REQUEST, "author-post", request);
  const { binding, evidence } = open;
  if (
    !("requirements" in binding) ||
    binding.requirements !== evidence.view.requirements
  ) {
    return {
      verdict: "failed",
      reason:
        "nothing posted: the issue's trusted requirements changed during the Author session",
    };
  }
  const by: Author = {
    role: "author",
    agent: "issue-pipeline-author",
    model: cfg.models.author,
    run: open.attempt.run.id,
  };
  if (reply.outcome === "gherkin") {
    commentByKey(cfg, open.number, by, {
      key: GHERKIN_KEY,
      body: gherkinBody(reply, binding.requirements),
    });
    let change = "the same behaviour";
    if (reply.changed) {
      change = "changed behaviour";
    }
    return {
      verdict: "passed",
      reason: `posted the issue's Gherkin, with ${change}`,
    };
  }
  commentByKey(cfg, open.number, by, {
    key: QUESTIONS_KEY,
    body: questionsBody(reply.questions),
  });
  return {
    verdict: "refused",
    reason: `the Author asked the issue's author ${String(reply.questions.length)} question(s)`,
  };
}

export { authorPost };
