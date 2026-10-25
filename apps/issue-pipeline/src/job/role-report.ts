// What a stage job's run reports besides its end: the role its usage
// records name, and a task job's report on its line, `unknown` when the
// run ended without the role's own.

import type { Stage } from "../stages.ts";
import type { RoleStageEnd } from "./role-end.ts";
import type { HardeningBuddy } from "./roles.ts";
import { jobRoleOf, stageAgentOf } from "./roles.ts";
import type { JobTask, TaskRequest } from "./task-request.ts";
import type { UsageRole } from "./usage-log.ts";

// The role a job's usage records name: its agent's model role, or the
// merger for a merge job, whose security session's records name the
// reviewer as the session's `name`.
function usageRoleOf(
  stage: Stage,
  hardening: HardeningBuddy,
  task: JobTask | null,
): UsageRole {
  if (jobRoleOf(stage, task) === "lander") {
    return "lander";
  }
  return stageAgentOf(stage, hardening, task).role;
}

// The job's end with its task's report: the role's, or `unknown` when the
// run ended without one, so a task job's line never omits it.
function withTaskReport(
  job: { task?: (TaskRequest & { name: JobTask }) | null },
  end: RoleStageEnd,
): RoleStageEnd {
  const task = job.task ?? null;
  if (task === null || end.kind !== "finished" || end.summary.task) {
    return end;
  }
  const { name: _name, ...request } = task;
  const report = { ...request, run: null, verdict: "unknown" as const };
  return { ...end, summary: { ...end.summary, task: report } };
}

export { usageRoleOf, withTaskReport };
