// The workflow's helpers, and the build's entry for them. build.ts bundles this
// module into an IIFE that it places ahead of the sweep's body in
// dist/workflow.js, and the body reads the helpers from `helpers` with one
// destructure. `helpers` lists exactly what workflow.js reads: the sweep's
// driver, which does everything but await its launches.

import { startSweep } from "./sweep.ts";

interface WorkflowHelpers {
  readonly startSweep: typeof startSweep;
}

const helpers: WorkflowHelpers = { startSweep };

export type { WorkflowHelpers };
export { helpers };
