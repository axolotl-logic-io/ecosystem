// How workflow.js runs the sweep's batches. Only the sandboxed body may await,
// and pi-subagents rejects nested async functions in a workflow, so this chains
// the batches with `then`, each on the last one's results, and the body awaits
// the chain once. Batches stay strictly sequential: each depends on the last.

import type { LaunchSpec } from "./launches.ts";
import type { Sweep } from "./types.ts";

// Runs one batch of launches and resolves to their raw results, in its order:
// workflow.js passes the sandbox's `runs.all`.
type RunBatch = (specs: readonly LaunchSpec[]) => Promise<readonly unknown[]>;

// Runs each batch the driver asks for, from its first, feeding its results
// back, until it asks for none. It reads only the driver's `next`.
function driveBatches(
  sweep: Pick<Sweep, "next">,
  runBatch: RunBatch,
): Promise<void> {
  function drive(specs: readonly LaunchSpec[]): Promise<void> {
    if (specs.length === 0) {
      return Promise.resolve();
    }
    return runBatch(specs).then((raw) => drive(sweep.next(raw)));
  }
  return drive(sweep.next([]));
}

export type { RunBatch };
export { driveBatches };
