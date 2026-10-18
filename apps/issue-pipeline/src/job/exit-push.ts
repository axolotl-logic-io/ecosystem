// What a stage job pushes as it exits: a writer runs the exit-push op on the
// commits its checkout holds, which the next claim may adopt as the saved
// head (src/adopt-push.ts); a reader or merger never pushes.

import process from "node:process";
import type { Stage } from "../stages.ts";
import type { RunOp } from "./ops-request.ts";
import { STAGE_ROLES } from "./roles.ts";

function unreachable(value: never): never {
  throw new Error(`job: unexpected role ${JSON.stringify(value)}`);
}

// The exit push of a `stage` job, run through `runOp`; null for a role that
// never pushes. A failed push is reported on stderr and does not change how
// the job ends.
function exitPushOf(stage: Stage, runOp: RunOp): (() => Promise<void>) | null {
  const role = STAGE_ROLES[stage];
  switch (role) {
    case "writer":
      return async (): Promise<void> => {
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
