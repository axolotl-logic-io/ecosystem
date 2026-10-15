// The stage dispatch: each stage's step machine, or null for a stage that
// still runs as its own block in workflow.js. The sweep's loop runs an issue's
// stage through its machine while the entry is filled.

import { next as nextFix } from "./fix.ts";
import { next as nextReview } from "./review.ts";
import { next as nextTriage } from "./triage.ts";
import type { StageMachine, StageName } from "./types.ts";

type StageDispatch = Readonly<Record<StageName, StageMachine | null>>;

const STAGES: StageDispatch = {
  triage: { next: nextTriage },
  spec: null,
  implement: null,
  "open-pr": null,
  review: { next: nextReview },
  fix: { next: nextFix },
  sync: null,
  checks: null,
  accept: null,
  security: null,
  merge: null,
};

export type { StageDispatch };
export { STAGES };
