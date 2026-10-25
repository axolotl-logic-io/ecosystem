// What a stage job pushes as it exits: a writer that claimed the issue runs
// the exit-push op on the commits its checkout holds, which the next claim
// may adopt as the saved head (src/adopt-push.ts); once the issue's code has
// landed (`codeMerged`) it pushes nothing, so no writer's unmerged code
// reaches the branch. The writers are the
// Developer's and the reviewer's (whose hardening commits) jobs. A reader
// never pushes, and neither does a merger: its integration's rebased or
// fixed head reaches the branch only through its role's own ops, never half
// done at exit. Neither does a job that never claimed the issue, nor a task
// job (#186): Sync pushes R′ only through its own op once it has checked it,
// and Integration only reads.

import process from "node:process";
import type { Stage } from "../stages.ts";
import type { IssueState } from "../state.ts";
import type { RunOp } from "./ops-request.ts";
import { STAGE_ROLES } from "./roles.ts";
import type { JobTask } from "./task-request.ts";

function unreachable(value: never): never {
  throw new Error(`job: unexpected role ${JSON.stringify(value)}`);
}

// The exit push of a `job.stage` job, run through `runOp` for the state
// `claimed()` reads as last saved (null before the claim won); null for a
// role that never pushes. A failed push is reported on stderr and does not
// change how the job ends.
function exitPushOf(
  job: { stage: Stage; task: JobTask | null },
  runOp: RunOp,
  claimed: () => IssueState | null,
): (() => Promise<void>) | null {
  if (job.task !== null) {
    return null;
  }
  const role = STAGE_ROLES[job.stage];
  switch (role) {
    case "writer":
      return async (): Promise<void> => {
        const state = claimed();
        if (state === null || state.codeMerged !== null) {
          return;
        }
        const reply = await runOp("exit-push", {});
        if (!reply.ok) {
          process.stderr.write(`job: exit push: ${reply.error}\n`);
        }
      };
    case "reader":
    case "merger":
      return null;
    default:
      return unreachable(role);
  }
}

export { exitPushOf };
