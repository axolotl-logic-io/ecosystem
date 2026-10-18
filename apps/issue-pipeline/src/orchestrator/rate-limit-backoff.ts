// The orchestrator's backoff after a transient provider error, a model
// provider's rate limit or a transport error reaching it
// (`rate-limit-defers`): once a stage job of this pipeline ends with its
// issue deferred on one (job.json's outcome `rateLimited`), the tick starts
// no stage job, and admits no restart, for rateLimitBackoffMinutes, logging
// each as held with reason `rate-limited`. A legacy job.json never counts. Each rate-limited end after a backoff has
// passed doubles the next, up to MAX_BACKOFF_MINUTES (or the configured
// minutes, if more); a job that finishes without one after a backoff has
// passed starts the next from the configured minutes again. The backoff
// holds every stage, merge included, so a model or GitHub outage isn't hit
// again by the next job. `runs/<slug>/backoff.json` keeps it between
// ticks; this module alone knows the file, a missing or malformed one reads
// as no backoff, and each save rewrites it atomically.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "../config.ts";
import { ROOT } from "../pipeline-root.ts";
import type { JobEnd } from "./queue.ts";

const BACKOFF_FILE = "backoff.json";
const JSON_INDENT = 2;
const MS_PER_MINUTE = 60_000;
const DEFAULT_BACKOFF_MINUTES = 5;
const MAX_BACKOFF_MINUTES = 30;
const HELD_REASON = "rate-limited";
const BACKOFF_SETTINGS = z.looseObject({
  rateLimitBackoffMinutes: z
    .number()
    .positive()
    .default(DEFAULT_BACKOFF_MINUTES),
});
const BACKOFF = z.object({
  // The end of the last rate-limited job seen, so no job counts twice.
  lastAt: z.string().nullable(),
  // When the latest backoff ends.
  until: z.string().nullable(),
  // The latest backoff's length; 0 once a job has finished without a rate
  // limit after it, so the next starts from the configured minutes.
  minutes: z.number(),
});
const NO_BACKOFF: Backoff = { lastAt: null, until: null, minutes: 0 };

type Backoff = z.infer<typeof BACKOFF>;

// A finished job's end, and whether its issue deferred on a transient
// provider error.
interface FinishedEnd {
  at: number;
  rateLimited: boolean;
}

function backoffFileOf(cfg: Config): string {
  return path.join(ROOT, "runs", cfg.slug, BACKOFF_FILE);
}

function readBackoff(cfg: Config): Backoff {
  try {
    const text = fs.readFileSync(backoffFileOf(cfg), "utf8");
    const parsed = BACKOFF.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // A missing or unreadable file starts with no backoff.
  }
  return NO_BACKOFF;
}

function saveBackoff(cfg: Config, backoff: Backoff): void {
  const file = backoffFileOf(cfg);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(backoff, null, JSON_INDENT)}\n`);
  fs.renameSync(temp, file);
}

// The finished jobs' ends, earliest first.
function endsOf(ends: readonly JobEnd[]): FinishedEnd[] {
  return ends
    .flatMap((end): FinishedEnd[] => {
      if (end.kind !== "finished") {
        return [];
      }
      return [{ at: Date.parse(end.at), rateLimited: end.rateLimited }];
    })
    .sort((a, b) => a.at - b.at);
}

function timeOf(at: string | null): number {
  if (at === null) {
    return Number.NEGATIVE_INFINITY;
  }
  return Date.parse(at);
}

// The backoff after `end`, from `backoff` and the configured `minutes`.
function backoffAfter(
  backoff: Backoff,
  end: FinishedEnd,
  minutes: number,
): Backoff {
  const until = timeOf(backoff.until);
  if (!end.rateLimited) {
    if (end.at > until) {
      return { ...backoff, minutes: 0 };
    }
    return backoff;
  }
  if (end.at <= timeOf(backoff.lastAt)) {
    return backoff;
  }
  const lastAt = new Date(end.at).toISOString();
  // A job that was already running when the backoff began.
  if (end.at < until) {
    return { ...backoff, lastAt };
  }
  let next = minutes;
  if (backoff.minutes > 0) {
    next = Math.min(
      backoff.minutes * 2,
      Math.max(MAX_BACKOFF_MINUTES, minutes),
    );
  }
  const ends = new Date(end.at + next * MS_PER_MINUTE).toISOString();
  return { lastAt, until: ends, minutes: next };
}

// Reads the backoff, adds the ends of this pipeline's jobs in `ends`, saves
// it and returns the reason every start and restart is held for at `now`,
// or null when no backoff runs.
function openBackoff(
  cfg: Config,
  ends: readonly JobEnd[],
  now: Date,
): typeof HELD_REASON | null {
  const { rateLimitBackoffMinutes } = BACKOFF_SETTINGS.parse(cfg);
  const backoff = endsOf(ends).reduce(
    (current, end) => backoffAfter(current, end, rateLimitBackoffMinutes),
    readBackoff(cfg),
  );
  saveBackoff(cfg, backoff);
  if (now.getTime() >= timeOf(backoff.until)) {
    return null;
  }
  return HELD_REASON;
}

export { openBackoff };
