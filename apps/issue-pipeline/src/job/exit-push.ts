// What a stage job pushes as it exits: a writer runs the exit-push op on the
// commits its checkout holds, which the next claim may adopt as the saved
// head (src/start-state.ts); a reader or merger never pushes.

import process from "node:process";
import { parseOps } from "../workflow/launch-results.ts";
import type { OpsFrame } from "../workflow/launches.ts";
import { opsSpec } from "../workflow/launches.ts";
import type { OpLaunch } from "../workflow/stages/types.ts";
import type { RunArgs } from "./args.ts";
import type { LaunchHooks } from "./launch.ts";
import { runLaunch } from "./launch.ts";
import { STAGE_ROLES } from "./roles.ts";

function unreachable(value: never): never {
  throw new Error(`job: unexpected role ${JSON.stringify(value)}`);
}

// The exit push of `args`'s job, its request framed by `frame` and run and
// recorded through `hooks`; null for a role that never pushes. A failed push
// is reported on stderr and does not change how the job ends.
function exitPushOf(
  args: RunArgs,
  frame: OpsFrame,
  hooks: LaunchHooks,
): (() => Promise<void>) | null {
  const role = STAGE_ROLES[args.stage];
  switch (role) {
    case "writer":
      return async (): Promise<void> => {
        const launch: OpLaunch = {
          kind: "op",
          name: "exit-push",
          op: "exit-push",
          payload: { number: args.issue },
        };
        const spec = opsSpec(frame, 1, launch, null);
        const { ok, error } = parseOps(await runLaunch(spec, hooks));
        if (ok !== true) {
          process.stderr.write(`job: exit push: ${String(error)}\n`);
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
