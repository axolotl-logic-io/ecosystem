// The workflow's helpers, and the build's entry for them. build.ts bundles this
// module into an IIFE that it places ahead of the sweep's body in
// dist/workflow.js, and the body reads the helpers from `helpers` with one
// destructure. `helpers` is the one list of what workflow.js may call: a name
// it reads that isn't here would be undefined.

import { chargeSession } from "./budget.ts";
import { clip } from "./clip.ts";
import { noteEvent } from "./event-log.ts";
import { findingLines } from "./findings.ts";
import { LENSES } from "./lenses.ts";
import { practicesNote, preamble } from "./prompts.ts";
import { REVIEW_SCHEMA } from "./review-schemas.ts";
import type { JsonSchema } from "./schemas.ts";
import { IMPL_SCHEMA, SPEC_SCHEMA } from "./schemas.ts";
import { by, byStep } from "./signing.ts";
import type { StageDispatch } from "./stages/index.ts";
import { STAGES } from "./stages/index.ts";
import { closeParentLaunches, parentsClosed } from "./stages/parents.ts";

interface WorkflowHelpers {
  readonly by: typeof by;
  readonly byStep: typeof byStep;
  readonly chargeSession: typeof chargeSession;
  readonly clip: typeof clip;
  readonly closeParentLaunches: typeof closeParentLaunches;
  readonly findingLines: typeof findingLines;
  readonly noteEvent: typeof noteEvent;
  readonly parentsClosed: typeof parentsClosed;
  readonly practicesNote: typeof practicesNote;
  readonly preamble: typeof preamble;
  readonly lenses: typeof LENSES;
  readonly implSchema: JsonSchema;
  readonly reviewSchema: JsonSchema;
  readonly specSchema: JsonSchema;
  readonly stages: StageDispatch;
}

const helpers: WorkflowHelpers = {
  by,
  byStep,
  chargeSession,
  clip,
  closeParentLaunches,
  findingLines,
  noteEvent,
  parentsClosed,
  practicesNote,
  preamble,
  lenses: LENSES,
  implSchema: IMPL_SCHEMA,
  reviewSchema: REVIEW_SCHEMA,
  specSchema: SPEC_SCHEMA,
  stages: STAGES,
};

export type { WorkflowHelpers };
export { helpers };
