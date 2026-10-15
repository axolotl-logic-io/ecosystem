// The workflow's helpers, and the build's entry for them. build.ts bundles this
// module into an IIFE that it places ahead of the sweep's body in
// dist/workflow.js, and the body reads the helpers from `helpers` with one
// destructure. `helpers` is the one list of what workflow.js may call: a name
// it reads that isn't here would be undefined.

import { chargeSession } from "./budget.ts";
import { clip } from "./clip.ts";
import { noteEvent } from "./event-log.ts";
import {
  addFinding,
  findingLines,
  findingsStopCode,
  findingsStopReason,
  findingsText,
  openFindings,
} from "./findings.ts";
import { LENSES, SECURITY_RULES } from "./lenses.ts";
import { practicesNote, preamble } from "./prompts.ts";
import { REVIEW_SCHEMA, SECURITY_SCHEMA } from "./review-schemas.ts";
import type { JsonSchema } from "./schemas.ts";
import { ACCEPT_SCHEMA, IMPL_SCHEMA, SPEC_SCHEMA } from "./schemas.ts";
import { by, byStep } from "./signing.ts";
import type { StageDispatch } from "./stages/index.ts";
import { STAGES } from "./stages/index.ts";
import { acceptanceSummary } from "./summary.ts";

interface WorkflowHelpers {
  readonly acceptanceSummary: typeof acceptanceSummary;
  readonly addFinding: typeof addFinding;
  readonly by: typeof by;
  readonly byStep: typeof byStep;
  readonly chargeSession: typeof chargeSession;
  readonly clip: typeof clip;
  readonly findingLines: typeof findingLines;
  readonly findingsStopCode: typeof findingsStopCode;
  readonly findingsStopReason: typeof findingsStopReason;
  readonly findingsText: typeof findingsText;
  readonly noteEvent: typeof noteEvent;
  readonly openFindings: typeof openFindings;
  readonly practicesNote: typeof practicesNote;
  readonly preamble: typeof preamble;
  readonly lenses: typeof LENSES;
  readonly securityRules: typeof SECURITY_RULES;
  readonly acceptSchema: JsonSchema;
  readonly implSchema: JsonSchema;
  readonly reviewSchema: JsonSchema;
  readonly securitySchema: JsonSchema;
  readonly specSchema: JsonSchema;
  readonly stages: StageDispatch;
}

const helpers: WorkflowHelpers = {
  acceptanceSummary,
  addFinding,
  by,
  byStep,
  chargeSession,
  clip,
  findingLines,
  findingsStopCode,
  findingsStopReason,
  findingsText,
  noteEvent,
  openFindings,
  practicesNote,
  preamble,
  lenses: LENSES,
  securityRules: SECURITY_RULES,
  acceptSchema: ACCEPT_SCHEMA,
  implSchema: IMPL_SCHEMA,
  reviewSchema: REVIEW_SCHEMA,
  securitySchema: SECURITY_SCHEMA,
  specSchema: SPEC_SCHEMA,
  stages: STAGES,
};

export type { WorkflowHelpers };
export { helpers };
