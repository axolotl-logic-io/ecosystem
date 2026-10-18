// How the role runner (runner.ts) ends a failed step the role doesn't take
// itself (`role-state-machines`, "Failures the runner owns", in the wiki's
// Pipeline-Roles-Shared page). A session's transient provider error is the
// runner's even where the role lists `failed` or has `recover` (#446,
// `rate-limit-defers`; `Walk.takesFailure` in src/roles/walk.ts): it holds
// the run as rate-limited, so the role never spends a retry on it.

import type { End } from "../roles/machine.ts";
import { isNetworkError } from "../workflow/stages/network.ts";
import { isTransientSessionError } from "../workflow/stages/rate-limit.ts";

// The end of a failed step, with the step-failure stop code (src/stops.ts).
const STEP_FAILED: End = { kind: "stopped", code: "error" };

// How the runner ends a step that failed with `error`: held as rate-limited
// on a rate limit, an overload or a transport error, held on another network
// error, and stopped with the step-failure code otherwise.
function failedEnd(error: string): End {
  if (isTransientSessionError(error)) {
    return { kind: "held", rateLimited: true };
  }
  if (isNetworkError(error)) {
    return { kind: "held" };
  }
  return STEP_FAILED;
}

export { failedEnd, STEP_FAILED };
