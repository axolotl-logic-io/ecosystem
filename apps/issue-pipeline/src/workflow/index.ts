// The workflow's helpers, and the build's entry for them. build.ts bundles this
// module into an IIFE that it places ahead of the sweep's body in
// dist/workflow.js, and the body reads the helpers from `helpers` with one
// destructure. `helpers` is the one list of what workflow.js may call: a name
// it reads that isn't here would be undefined.

import { chargeSession } from "./budget.ts";
import { clip } from "./clip.ts";
import {
  addFinding,
  findingLines,
  findingsStopCode,
  findingsStopReason,
  findingsText,
  openFindings,
} from "./findings.ts";
import { ALL_LENSES, LENS_NAMES, LENSES, SECURITY_RULES } from "./lenses.ts";
import { practicesNote, preamble } from "./prompts.ts";
import {
  AGG_SCHEMA,
  FIX_SCHEMA,
  REREVIEW_SCHEMA,
  REREVIEW_SEC_SCHEMA,
  REVIEW_SCHEMA,
  SECURITY_SCHEMA,
} from "./review-schemas.ts";
import type { JsonSchema } from "./schemas.ts";
import {
  ACCEPT_SCHEMA,
  CIFIX_SCHEMA,
  IMPL_SCHEMA,
  SPEC_SCHEMA,
  TRIAGE_SCHEMA,
} from "./schemas.ts";
import { by, byStep } from "./signing.ts";
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
  readonly openFindings: typeof openFindings;
  readonly practicesNote: typeof practicesNote;
  readonly preamble: typeof preamble;
  readonly allLenses: typeof ALL_LENSES;
  readonly lensNames: typeof LENS_NAMES;
  readonly lenses: typeof LENSES;
  readonly securityRules: typeof SECURITY_RULES;
  readonly acceptSchema: JsonSchema;
  readonly aggSchema: JsonSchema;
  readonly cifixSchema: JsonSchema;
  readonly fixSchema: JsonSchema;
  readonly implSchema: JsonSchema;
  readonly rereviewSchema: JsonSchema;
  readonly rereviewSecSchema: JsonSchema;
  readonly reviewSchema: JsonSchema;
  readonly securitySchema: JsonSchema;
  readonly specSchema: JsonSchema;
  readonly triageSchema: JsonSchema;
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
  openFindings,
  practicesNote,
  preamble,
  allLenses: ALL_LENSES,
  lensNames: LENS_NAMES,
  lenses: LENSES,
  securityRules: SECURITY_RULES,
  acceptSchema: ACCEPT_SCHEMA,
  aggSchema: AGG_SCHEMA,
  cifixSchema: CIFIX_SCHEMA,
  fixSchema: FIX_SCHEMA,
  implSchema: IMPL_SCHEMA,
  rereviewSchema: REREVIEW_SCHEMA,
  rereviewSecSchema: REREVIEW_SEC_SCHEMA,
  reviewSchema: REVIEW_SCHEMA,
  securitySchema: SECURITY_SCHEMA,
  specSchema: SPEC_SCHEMA,
  triageSchema: TRIAGE_SCHEMA,
};

export type { WorkflowHelpers };
export { helpers };
