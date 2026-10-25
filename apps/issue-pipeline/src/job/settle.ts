// The end of a stage job's run (job.ts): it waits for the run's end and
// records it in job.json, then, whatever happened, tears the job down,
// relinquishes only through the release predicate (invocation.ts) and closes
// its control socket.

import type { Config } from "../config.ts";
import type { Control } from "./control.ts";
import type { SettlingJob } from "./invocation.ts";
import { settleInvocation } from "./invocation.ts";
import type { JobOutcome } from "./status.ts";
import type { RunEnd } from "./teardown.ts";
import { isTransientSessionError } from "./transient.ts";

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function settle(
  cfg: Config,
  ending: Promise<RunEnd>,
  job: SettlingJob & { control: Control },
  warn: (line: string) => void,
): Promise<RunEnd> {
  const { status, control } = job;
  let end: RunEnd | null = null;
  try {
    end = await ending;
    status.finish(outcomeOf(end));
    return end;
  } catch (error: unknown) {
    status.finish({ kind: "failed", error: messageOf(error) });
    throw error;
  } finally {
    try {
      await settleInvocation(cfg, job, end, warn);
    } finally {
      control.close();
    }
  }
}

// job.json's outcome of a run that ended as `end`: a finished run's end,
// whether it deferred on a model provider's rate limit or transport error
// (for the orchestrator's backoff), and its claim's error, if any.
function outcomeOf(end: RunEnd): JobOutcome {
  if (end.kind === "stopped") {
    return { kind: "stopped", signal: end.signal };
  }
  const { summary } = end;
  const rateLimited =
    summary.end === "deferred" &&
    isTransientSessionError(summary.reason ?? null);
  if (summary.claimError === undefined) {
    return { kind: "finished", end: summary.end, rateLimited };
  }
  const { claimError } = summary;
  return { kind: "finished", end: summary.end, rateLimited, claimError };
}

export { settle };
