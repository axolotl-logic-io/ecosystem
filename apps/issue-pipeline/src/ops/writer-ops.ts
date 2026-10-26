// The writer tasks' own ops (tasks/author.ts, implement.ts and fix.ts),
// beside the shared push and PR ops: such as Fix's merge of the base into
// the PR head, its finish after a conflict session, its thread replies and
// its read-only reconciliation. ops/task-ops.ts serves every op listed
// here.
//
// Not built yet: the writer tasks have no ops of their own.

import type { TaskOpSpec } from "./task-guard.ts";

const WRITER_OPS: readonly TaskOpSpec[] = [];

export { WRITER_OPS };
