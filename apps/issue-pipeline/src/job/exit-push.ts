// What a stage job pushes as it exits: a writer that claimed the issue runs
// the exit-push op on the commits its checkout holds, which the next claim
// may adopt as the saved head (src/adopt-push.ts); once the issue's code is
// merged (`codeMerged`) it pushes only its wiki, through `push {wikiOnly}`,
// so no writer's unmerged code reaches the branch. A reader or merger never
// pushes, and neither does a job that never claimed the issue.

import process from "node:process";
import type { Stage } from "../stages.ts";
import type { IssueState } from "../state.ts";
import type { RunOp } from "./ops-request.ts";
import { STAGE_ROLES } from "./roles.ts";

function unreachable(value: never): never {
  throw new Error(`job: unexpected role ${JSON.stringify(value)}`);
}

// The exit push of a `stage` job, run through `runOp` for the state
// `claimed()` reads as last saved (null before the claim won); null for a
// role that never pushes. A failed push is reported on stderr and does not
// change how the job ends.
function exitPushOf(
  stage: Stage,
  runOp: RunOp,
  claimed: () => IssueState | null,
): (() => Promise<void>) | null {
  const role = STAGE_ROLES[stage];
  switch (role) {
    case "writer":
      return async (): Promise<void> => {
        const state = claimed();
        if (state === null) {
          return;
        }
        let op = "exit-push";
        let payload = {};
        if (state.codeMerged !== null) {
          op = "push";
          payload = { wikiOnly: true };
        }
        const reply = await runOp(op, payload);
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
