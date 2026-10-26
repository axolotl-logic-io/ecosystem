// Verify's ops (tasks/verify.ts): the effects that check one exact PR head
// and submit its review through the landing account, and the read-only
// reconciliation of an unsettled Verify. ops/task-ops.ts serves every op
// listed here.
//
// Not built yet: Verify has no ops.

import type { TaskOpSpec } from "./task-guard.ts";

const VERIFY_OPS: readonly TaskOpSpec[] = [];

export { VERIFY_OPS };
