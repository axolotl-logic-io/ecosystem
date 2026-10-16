// The workflow's helpers, and the build's entry for them. build.ts bundles this
// module into an IIFE that it places ahead of the sweep's body in
// dist/workflow.js, and the body reads the helpers from `helpers` with one
// destructure. `helpers` lists exactly what workflow.js reads: the sweep's
// driver, which does everything but await its launches, and driveBatches,
// which chains the driver's batches for the body to await.

import { driveBatches } from "./batches.ts";
import { startSweep } from "./sweep.ts";

interface WorkflowHelpers {
  readonly startSweep: typeof startSweep;
  readonly driveBatches: typeof driveBatches;
}

const helpers: WorkflowHelpers = { startSweep, driveBatches };

export type { WorkflowHelpers };
export { helpers };
