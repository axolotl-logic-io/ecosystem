// The stage dispatch: each stage's step machine, or null for a stage that
// still runs as its own block in workflow.js. The sweep's loop runs an issue's
// stage through its machine while the entry is filled.

import { next as nextAccept } from "./accept.ts";
import { next as nextChecks } from "./checks.ts";
import { next as nextFix } from "./fix.ts";
import { next as nextImplement } from "./implement.ts";
import { next as nextMerge } from "./merge.ts";
import { next as nextOpenPr } from "./open-pr.ts";
import { next as nextReview } from "./review.ts";
import { next as nextSecurity } from "./security.ts";
import { next as nextSpec } from "./spec.ts";
import { next as nextSync } from "./sync.ts";
import { next as nextTriage } from "./triage.ts";
import type { StageMachine, StageName } from "./types.ts";

type StageDispatch = Readonly<Record<StageName, StageMachine | null>>;

const STAGES: StageDispatch = {
  triage: { next: nextTriage },
  spec: { next: nextSpec },
  implement: { next: nextImplement },
  "open-pr": { next: nextOpenPr },
  review: { next: nextReview },
  fix: { next: nextFix },
  sync: { next: nextSync },
  checks: { next: nextChecks },
  accept: { next: nextAccept },
  security: { next: nextSecurity },
  merge: { next: nextMerge },
};

export type { StageDispatch };
export { STAGES };
