// The writer tasks' own ops (tasks/author.ts, implement.ts and fix.ts),
// beside the shared push and PR ops that Implement uses: Author's post of
// its Gherkin or questions, and Fix's merge of the base into the PR head,
// its finish after its session and its read-only reconciliation.
// ops/task-ops.ts serves every op listed here.

import { authorPost } from "./author-post.ts";
import { FIX_OPS } from "./fix-task.ts";
import type { TaskOpSpec } from "./task-guard.ts";

const WRITER_OPS: readonly TaskOpSpec[] = [
  { name: "author-post", kind: "substantive", op: authorPost },
  ...FIX_OPS,
];

export { WRITER_OPS };
