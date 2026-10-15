// The ask op: posts triage's questions on the issue and parks it at
// agent:needs-info until an allowed user answers.

import { z } from "zod";
import { closeClaims } from "../claims.ts";
import type { Author } from "../comments.ts";
import { comment } from "../comments.ts";
import type { Config } from "../config.ts";
import { LABELS, setLabels } from "../labels.ts";
import { writeState } from "../state.ts";

// A signature field the workflow sends as null when it has no value.
const SIGNATURE_TEXT = z
  .string()
  .nullish()
  .transform((text) => text ?? undefined);

const ASK_REQUEST = z.looseObject({
  by: z
    .looseObject({
      agent: SIGNATURE_TEXT,
      model: SIGNATURE_TEXT,
      role: SIGNATURE_TEXT,
      run: SIGNATURE_TEXT,
    })
    .nullish(),
  number: z.number(),
  questions: z.array(z.string()).nullish(),
  state: z.record(z.string(), z.unknown()).nullish(),
});

type AskRequest = z.infer<typeof ASK_REQUEST>;

// Who signs the questions: the agent the workflow names, or triage.
function authorOf(by: AskRequest["by"]): Author {
  if (by === undefined || by === null) {
    return { role: "triage" };
  }
  return by;
}

function ask(cfg: Config, request: unknown): Record<string, never> {
  const { by, number: n, questions, state } = ASK_REQUEST.parse(request);
  const numbered = (questions ?? [])
    .map((question, index) => `${index + 1}. ${question}`)
    .join("\n");
  comment(
    cfg,
    n,
    authorOf(by),
    `I need answers before the pipeline can work on this issue:\n\n${numbered}\n\nReply in a comment. A reply from a user on the pipeline's allow list puts the issue back in the queue.`,
  );
  writeState(cfg, n, {
    ...state,
    stage: "triage",
    questionsAt: new Date().toISOString(),
    lease: null,
  });
  setLabels(cfg, n, [LABELS.needsInfo.name], [LABELS.working.name]);
  closeClaims(
    cfg,
    n,
    "the pipeline asked questions; an answer puts the issue back in the queue.",
  );
  return {};
}

export { ask };
