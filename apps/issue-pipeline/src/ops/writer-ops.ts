// The writer tasks' own ops (tasks/implement.ts and fix.ts), beside the
// shared push and PR ops that Implement uses: Implement's read-only
// reconciliation of an interrupted run, and Fix's merge of the base into
// the PR head, its finish after its session and its read-only
// reconciliation.
// ops/task-ops.ts serves every op listed here.

import { FIX_OPS } from "./fix-task.ts";
import { implementReconcile } from "./implement-task.ts";
import type { TaskOpSpec } from "./task-guard.ts";

const WRITER_OPS: readonly TaskOpSpec[] = [
  {
    name: "implement-reconcile",
    kind: "finalization",
    op: implementReconcile,
  },
  ...FIX_OPS,
];

export { WRITER_OPS };
