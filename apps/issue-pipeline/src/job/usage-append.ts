// A role job's usage effect (src/job/runner.ts): it turns each of the
// runner's usage entries into a record with the job's identity, checks it
// with the serializer (usage-log.ts) and hands its line to `send`, the
// `usage` op. A record the serializer refuses is dropped, and a line `send`
// fails to append is sent once more and then dropped, so the usage log never
// stops an issue.

import type { UsageEntry } from "./run-usage.ts";
import type { UsageContext } from "./usage-log.ts";
import { jobRecord, serializeUsage, usageRecord } from "./usage-log.ts";

// Tries to append `line` to the issue's usage comments; true when it did.
type Send = (line: string) => Promise<boolean>;

function recordOf(entry: UsageEntry, context: UsageContext): unknown {
  switch (entry.kind) {
    case "session":
      return usageRecord(entry, context);
    case "job":
      return jobRecord(entry, context);
    default:
      return unreachable(entry);
  }
}

function lineOf(entry: UsageEntry, context: UsageContext): string | null {
  try {
    return serializeUsage(recordOf(entry, context));
  } catch {
    return null;
  }
}

async function sent(send: Send, line: string): Promise<boolean> {
  try {
    return await send(line);
  } catch {
    return false;
  }
}

// The usage effect of a job with `context`; it never rejects.
function usageAppender(
  context: UsageContext,
  send: Send,
): (entry: UsageEntry) => Promise<void> {
  return async (entry: UsageEntry): Promise<void> => {
    const line = lineOf(entry, context);
    if (line === null) {
      return;
    }
    if (!(await sent(send, line))) {
      await sent(send, line);
    }
  };
}

function unreachable(value: never): never {
  throw new Error(`usage append: unexpected ${JSON.stringify(value)}`);
}

export { usageAppender };
