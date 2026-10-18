// How a finalizer step ends the run, and how it notes what happened: a step
// that decides the outcome records its end in `data`, and every later step
// is skipped. A failed op ends held on a network error, since the next tick
// is likely to get through, and stops otherwise. Pure.

import { noteEvent } from "../../workflow/event-log.ts";
import { isNetworkError } from "../../workflow/stages/network.ts";
import type { End } from "../machine.ts";
import type { FinalizerData, FinalizerStop } from "./locate.ts";
import { stopEnd } from "./locate.ts";

// The end of a run that no step ended, which is a bug in the script.
const NO_OUTCOME = "the finalizer reached its end without an outcome";

// `data` with `text` added to the issue's event log.
function noted(data: FinalizerData, text: string): FinalizerData {
  const next = { ...data, log: [...data.log] };
  noteEvent(next, text, data.at);
  return next;
}

// `data` ended as `end`.
function ended(data: FinalizerData, end: End): FinalizerData {
  return { ...data, end };
}

// `data` ended by `stop`.
function stopped(data: FinalizerData, stop: FinalizerStop): FinalizerData {
  return ended(data, stopEnd(data.issue, stop));
}

// `data` stopped with `reason` and `detail`, under the code the reason names.
function stoppedFor(
  data: FinalizerData,
  reason: string,
  detail: string | null,
): FinalizerData {
  return stopped(data, { code: null, reason, detail });
}

// `data` held at its stage for the next tick.
function held(data: FinalizerData): FinalizerData {
  return ended(data, { kind: "held" });
}

// `data` once op `op` failed with `error`: held on a network error, with a
// note, and otherwise stopped with `reason` and the error as the detail.
function opFailed(
  data: FinalizerData,
  op: string,
  reason: string,
  error: string,
): FinalizerData {
  if (isNetworkError(error)) {
    return held(
      noted(data, `deferred: network error during ${op}; will retry`),
    );
  }
  return stoppedFor(data, reason, error);
}

// How the run ends: as a step decided, or as a failed step.
function endOf(data: FinalizerData): End {
  return (
    data.end ??
    stopEnd(data.issue, { code: "error", reason: NO_OUTCOME, detail: null })
  );
}

export { ended, endOf, held, noted, opFailed, stopped, stoppedFor };
