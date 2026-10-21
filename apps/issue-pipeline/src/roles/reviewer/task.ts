// The task of the Reviewer's hardening, the review stage's one session: the
// issue's facts, its Gherkin and the change's scope. The hardening's
// behaviour is its prompt page (task-facts.ts). Pure.

import type { RoleContext } from "../../job/role-context.ts";
import type { Mode } from "../change-task.ts";
import { scopeLines } from "../change-task.ts";
import {
  fullCheckLines,
  header,
  replyLines,
  requirementsLines,
} from "../task-facts.ts";

function hardeningTask(ctx: RoleContext, mode: Mode): string {
  return [
    ...header(ctx, "hardening"),
    ...scopeLines(ctx, mode),
    ...fullCheckLines(ctx),
    ...requirementsLines(ctx),
    ...replyLines([
      "`done`, with a `summary` of what you examined, the tests you added and the defects you fixed, once it is committed.",
      "`cannot`, with the `reason` naming the question only a person can answer.",
    ]),
  ].join("\n");
}

export { hardeningTask };
