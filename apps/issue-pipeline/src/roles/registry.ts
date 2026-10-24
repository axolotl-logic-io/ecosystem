// The role each stage job runs, and the role of each task a job may be
// asked to run (`--task`, #186). A stage with no role yet is refused by the
// job with an explicit error; it never succeeds without its role.

import type { Role } from "../job/role-context.ts";
import type { JobTask } from "../job/task-request.ts";
import type { Stage } from "../stages.ts";
import { authorRole } from "./author/author.ts";
import { implementorRole } from "./implementor/implementor.ts";
import { integrationRole } from "./integration/integration.ts";
import { mergeRole } from "./merge/merge.ts";
import { reviewerRole } from "./reviewer/reviewer.ts";
import { syncRole } from "./sync/sync.ts";

const ROLES: Readonly<Partial<Record<Stage, Role>>> = {
  author: authorRole,
  implement: implementorRole,
  review: reviewerRole,
  merge: mergeRole,
};

const TASK_ROLES: Readonly<Record<JobTask, Role>> = {
  sync: syncRole,
  integration: integrationRole,
};

// The stage's role, or the task's when the job runs one; undefined when none
// is registered.
function roleOf(stage: Stage, task: JobTask | null = null): Role | undefined {
  if (task !== null) {
    return TASK_ROLES[task];
  }
  const { [stage]: role } = ROLES;
  return role;
}

export { roleOf };
