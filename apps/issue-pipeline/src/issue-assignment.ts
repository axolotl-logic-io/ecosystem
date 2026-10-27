// Issue assignment, which shows people who is working on an issue and lets a
// person take one over. It grants nothing: the coordination store still
// decides which pipeline instance owns an issue, and no signal, prerequisite
// or authority read uses it. If a person is assigned to an issue, the
// pipeline leaves it to them: the code-writing tasks, Implement and Fix,
// don't start on it. Once one of them records an attempt, the development
// account is assigned too, and when it settles and releases the issue the
// development account removes only itself.

import { z } from "zod";
import type { Config } from "./config.ts";
import type { TaskId } from "./domain.ts";
import { gh, ghJson } from "./github.ts";

// The tasks that assign the development account and back off from a person.
const ASSIGNING_TASKS: ReadonlySet<TaskId> = new Set(["implement", "fix"]);
const ASSIGNEES = z.looseObject({
  assignees: z.array(z.looseObject({ login: z.string().min(1) })),
});

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Whether actions of `task` assign the development account and back off from
// an assigned person.
function assignsIssue(task: TaskId): boolean {
  return ASSIGNING_TASKS.has(task);
}

// The first person assigned to issue `issue` on a fresh read: an assignee
// that is neither the development nor the landing account, compared without
// case. Null when no person is assigned; throws when the read fails.
function assignedPerson(cfg: Config, issue: number): string | null {
  const { assignees } = ASSIGNEES.parse(
    ghJson(cfg, "landing", ["api", `repos/${cfg.repo}/issues/${issue}`]),
  );
  const machines = new Set(
    [cfg.devAccount, cfg.landingAccount].map((login) => login.toLowerCase()),
  );
  const person = assignees.find(
    (assignee) => !machines.has(assignee.login.toLowerCase()),
  );
  return person?.login ?? null;
}

// Adds or removes the development account, by itself, as an assignee of
// `issue`, and never touches another assignee. Returns why the change
// failed, or null; never throws. Each change is display only and safe to
// repeat, so it is fenced by the action's ownership but journals nothing: a
// lost answer leaves nothing to reconcile.
function changeOwnAssignment(
  cfg: Config,
  issue: number,
  change: "add" | "remove",
): string | null {
  let method = "POST";
  if (change === "remove") {
    method = "DELETE";
  }
  const endpoint = `repos/${cfg.repo}/issues/${issue}/assignees`;
  try {
    gh(cfg, "dev", ["api", "-X", method, endpoint, "--input", "-"], {
      input: JSON.stringify({ assignees: [cfg.devAccount] }),
      reconciles: true,
    });
    return null;
  } catch (error: unknown) {
    return messageOf(error);
  }
}

export { assignedPerson, assignsIssue, changeOwnAssignment };
