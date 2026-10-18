// How a role's effects become a stage job's launches (src/job/role-run.ts):
// an op effect as the op's launch for the issue, a session effect as the
// sweep would launch it, and an op's reply as the effect's outcome.

import type { SessionEffect } from "../roles/machine.ts";
import type { ChildLaunch, OpLaunch } from "../workflow/stages/types.ts";
import type { Outcome } from "./run-step.ts";

type Reply = Readonly<Record<string, unknown>>;

function succeeded(reply: Reply): boolean {
  const { ok } = reply;
  return ok === true;
}

function errorOf(reply: Reply): string {
  const { error } = reply;
  if (typeof error === "string") {
    return error;
  }
  return "the op failed with no error";
}

function opOutcome(reply: Reply): Outcome {
  if (succeeded(reply)) {
    return { ok: true, name: "ok", reply };
  }
  return { ok: false, error: errorOf(reply) };
}

// The launch of role session `effect`, as the sweep would launch it: its
// timeout is the effect's minutes (the default without them), and a
// writer's launch says so, which gives it the writer's acceptance.
function sessionLaunchOf(effect: SessionEffect): ChildLaunch {
  const { name, agent, model, schema, task, tokenBudget, budgetRole } = effect;
  const child: ChildLaunch = {
    kind: "child",
    name,
    label: `Run ${name} session`,
    agent,
    model,
    schema,
    minutes: effect.minutes ?? 0,
    task,
    tokenBudget,
    budgetRole,
  };
  if (effect.writer === true) {
    child.writer = true;
  }
  return child;
}

function opLaunchOf(issue: number, op: string, payload: Reply): OpLaunch {
  return {
    kind: "op",
    name: `i${issue}-${op}`,
    op,
    payload: { ...payload, number: issue },
  };
}

export type { Reply };
export { opLaunchOf, opOutcome, sessionLaunchOf, succeeded };
