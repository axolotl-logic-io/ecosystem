// The stage dispatch: each stage's step machine. The sweep's driver
// (../sweep.ts) runs an issue's stage through its machine.

import { next as nextAccept } from "./accept.ts";
import { next as nextChecks } from "./checks.ts";
import { next as nextFix } from "./fix.ts";
import { next as nextImplement } from "./implement.ts";
import { next as nextMerge } from "./merge.ts";
import { next as nextOpenPr } from "./open-pr.ts";
import { next as nextPublish } from "./publish.ts";
import { next as nextReview } from "./review.ts";
import { next as nextSecurity } from "./security.ts";
import { next as nextSpec } from "./spec.ts";
import { next as nextSync } from "./sync.ts";
import { next as nextTriage } from "./triage.ts";
import type { StageMachine, StageName } from "./types.ts";

type StageDispatch = Readonly<Record<StageName, StageMachine>>;

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
  publish: { next: nextPublish },
};

export type { StageDispatch };
export { STAGES };
