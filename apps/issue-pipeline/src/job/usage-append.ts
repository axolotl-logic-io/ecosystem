// A stage job's usage effect: it turns each of the job's usage entries into
// a record with the job's identity, checks it with the serializer
// (usage-log.ts) and hands its line to `send`, the `usage` op. A record the
// serializer refuses is dropped and reported on stderr (the job's job.log),
// and a line `send` fails to append is sent once more and then dropped, so
// the usage log never stops an issue. A job record is also appended to
// `jobs.jsonl` in the issue's run folder, refused or not.

import process from "node:process";
import { z } from "zod";
import { appendRunLine } from "./run-log.ts";
import type { UsageEntry } from "./run-usage.ts";
import type { UsageContext } from "./usage-log.ts";
import { jobRecord, serializeUsage, usageRecord } from "./usage-log.ts";

// Tries to append `line` to the issue's usage comments; true when it did.
type Send = (line: string) => Promise<boolean>;

// Where a job's usage goes: the usage op, and the issue's run folder.
interface UsageSinks {
  send: Send;
  runDir: string;
}

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

// Why the serializer refused a record, on one line.
function refusalOf(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
  }
  return String(error);
}

function lineOf(entry: UsageEntry, record: unknown): string | null {
  try {
    return serializeUsage(record);
  } catch (error: unknown) {
    process.stderr.write(
      `job: usage: dropped the ${entry.kind} record: ${refusalOf(error)}\n`,
    );
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
  sinks: UsageSinks,
): (entry: UsageEntry) => Promise<void> {
  return async (entry: UsageEntry): Promise<void> => {
    const record = recordOf(entry, context);
    if (entry.kind === "job") {
      appendRunLine(sinks.runDir, "jobs.jsonl", record);
    }
    const line = lineOf(entry, record);
    if (line === null) {
      return;
    }
    if (!(await sent(sinks.send, line))) {
      await sent(sinks.send, line);
    }
  };
}

function unreachable(value: never): never {
  throw new Error(`usage append: unexpected ${JSON.stringify(value)}`);
}

export type { Send };
export { usageAppender };
