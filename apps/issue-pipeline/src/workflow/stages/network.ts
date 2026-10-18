// Which op errors are network failures, in any letter case: a DNS failure, a
// refused, reset or timed-out connection, or a gateway error (HTTP 502, 503
// or 504) from gh or git. A stage defers on these instead of stopping, since
// the next sweep is likely to get through.

import { deferStep, stopStep } from "./step.ts";
import type { StageState, Step } from "./types.ts";

const NETWORK_ERROR: RegExp =
  /Could not resolve host|error connecting to api\.github\.com|Connection timed out|Connection reset|HTTP 50[234]\b|The requested URL returned error: 50[234]\b/iu;

// Whether an op's error text, if any, reports a network failure.
function isNetworkError(text: string | null): boolean {
  if (text === null) {
    return false;
  }
  return NETWORK_ERROR.test(text);
}

// An ops request that failed: the op's name, the stop's reason if it stops,
// and the reply's error.
interface FailedOp {
  op: string;
  reason: string;
  error: string | null;
}

// The step for a failed ops request: a deferral when its error is a network
// error, otherwise a stop with its reason and the error as the detail.
function opFailedStep(state: StageState, failed: FailedOp, now: Date): Step {
  if (isNetworkError(failed.error)) {
    return deferStep(state, failed.op, now);
  }
  return stopStep(state, failed.reason, failed.error);
}

export type { FailedOp };
export { isNetworkError, opFailedStep };
