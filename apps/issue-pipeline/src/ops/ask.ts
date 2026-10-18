// The ask op: posts the author's questions on the issue and parks it at
// agent:needs-info until an allowed user answers. It writes the job's state
// as given (the job records what was asked in it), back at the author with
// no lease, and replies with the state it wrote, for the job's later writes.

import { z } from "zod";
import { closeClaims } from "../claims.ts";
import { AUTHOR, comment } from "../comments.ts";
import type { Config } from "../config.ts";
import { LABELS, setLabels } from "../labels.ts";
import { parseRequest } from "../process.ts";
import { readWriteState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import { ISSUE_STATE } from "../state.ts";
import { saveIssueState } from "./save-state.ts";

const ASK_REQUEST = z.looseObject({
  by: AUTHOR.extend({ role: z.string().min(1) }),
  number: z.number().int().positive(),
  questions: z.array(z.string().min(1)).min(1),
  state: ISSUE_STATE,
});

function ask(cfg: Config, request: unknown): { state: IssueState } {
  const req = parseRequest(ASK_REQUEST, "ask", request);
  const n = req.number;
  readWriteState(cfg, n);
  const numbered = req.questions
    .map((question, index) => `${index + 1}. ${question}`)
    .join("\n");
  comment(
    cfg,
    n,
    req.by,
    `I need answers before the pipeline can work on this issue:\n\n${numbered}\n\nReply in a comment. A reply from a user on the pipeline's allow list puts the issue back in the queue.`,
  );
  const state = saveIssueState(cfg, n, {
    ...req.state,
    stage: "author",
    lease: null,
  });
  setLabels(cfg, n, [LABELS.needsInfo.name], [LABELS.working.name]);
  closeClaims(
    cfg,
    n,
    "the pipeline asked questions; an answer puts the issue back in the queue.",
  );
  return { state };
}

export { ask };
