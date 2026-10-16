// The orchestrator's ledger, `runs/<slug>/orchestrator.json` (#234): the
// tokens each stage job's launches spent, kept as increments in time so the
// hourly rate limit can count them even after a job.json is overwritten, and
// the jobs the orchestrator started, which cover the gap before a job writes
// its own job.json. It keeps an hour of both. It alone knows the file's
// layout; each save rewrites the whole file atomically. The tokens it counts
// are `rateTokens` (../workflow/rate-tokens.ts), which leave out cache reads.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { StatusFile } from "../job/status.ts";
import { ROOT } from "../pipeline-root.ts";
import { rateTokens } from "../workflow/rate-tokens.ts";

const LEDGER_FILE = "orchestrator.json";
const HOUR_MS = 3_600_000;
const JSON_INDENT = 2;
const INCREMENT = z.object({ at: z.string(), tokens: z.number() });
const LAUNCH = z.object({ seen: z.number(), increments: z.array(INCREMENT) });
const STARTED = z.object({
  issue: z.number(),
  stage: z.string(),
  pid: z.number(),
  at: z.string(),
});
const LEDGER = z.object({
  launches: z.record(z.string(), LAUNCH),
  started: z.array(STARTED),
});

type LaunchTokens = z.infer<typeof LAUNCH>;
type StartRecord = z.infer<typeof STARTED>;

interface Ledger {
  // The jobs started within the last hour.
  started: () => readonly StartRecord[];
  // Adds what the jobs' launches spent since the last record.
  record: (jobs: readonly StatusFile[], now: Date) => void;
  // The tokens the launches spent in the hour before `now`.
  spentLastHour: (now: Date) => number;
  // Notes a job the orchestrator started.
  launched: (start: StartRecord) => void;
  // Writes the ledger, keeping the last hour.
  save: (now: Date) => void;
}

function ledgerFileOf(cfg: Config): string {
  return path.join(ROOT, "runs", cfg.slug, LEDGER_FILE);
}

// The saved ledger, or an empty one when it is missing or malformed.
function readLedger(file: string): z.infer<typeof LEDGER> {
  try {
    const parsed = LEDGER.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // A missing or unreadable file starts an empty ledger.
  }
  return { launches: {}, started: [] };
}

function writeLedger(file: string, ledger: z.infer<typeof LEDGER>): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(ledger, null, JSON_INDENT)}\n`);
  fs.renameSync(temp, file);
}

function withinHour(at: string, now: Date): boolean {
  return now.getTime() - Date.parse(at) < HOUR_MS;
}

// The launch's tokens once its job.json shows `total` tokens spent, the last
// of them at `active`. A launch first seen with no event in the last hour
// spent its tokens before that hour, as after a lost ledger, so none count.
function recorded(
  earlier: LaunchTokens | undefined,
  total: number,
  active: string,
  now: Date,
): LaunchTokens {
  let seen = earlier?.seen ?? 0;
  if (earlier === undefined && !withinHour(active, now)) {
    seen = total;
  }
  const increments = [...(earlier?.increments ?? [])];
  if (total > seen) {
    increments.push({ at: now.toISOString(), tokens: total - seen });
  }
  return { seen: Math.max(seen, total), increments };
}

type Launches = Map<string, LaunchTokens>;

// Adds each launch's tokens since its last record, noting the launches seen.
function recordJobs(
  launches: Launches,
  seen: Set<string>,
  jobs: readonly StatusFile[],
  now: Date,
): void {
  for (const job of jobs) {
    for (const launch of job.launches) {
      const id = `${job.startedAt} ${launch.key}`;
      const total = rateTokens(launch.usage);
      // Each event that adds usage moves lastEventAt.
      const active = launch.lastEventAt ?? launch.startedAt;
      launches.set(id, recorded(launches.get(id), total, active, now));
      seen.add(id);
    }
  }
}

function spentWithin(launches: Launches, now: Date): number {
  return [...launches.values()]
    .flatMap((launch) => launch.increments)
    .filter((increment) => withinHour(increment.at, now))
    .reduce((sum, increment) => sum + increment.tokens, 0);
}

// The launches with tokens spent in the last hour or a job.json that still
// names them, which keeps their totals from counting twice.
function keptLaunches(
  launches: Launches,
  seen: ReadonlySet<string>,
  now: Date,
): Record<string, LaunchTokens> {
  const kept: [string, LaunchTokens][] = [];
  for (const [id, launch] of launches) {
    const increments = launch.increments.filter((i) => withinHour(i.at, now));
    if (increments.length > 0 || seen.has(id)) {
      kept.push([id, { seen: launch.seen, increments }]);
    }
  }
  return Object.fromEntries(kept);
}

function openLedger(cfg: Config): Ledger {
  const file = ledgerFileOf(cfg);
  const saved = readLedger(file);
  const launches: Launches = new Map(Object.entries(saved.launches));
  let { started } = saved;
  const seen = new Set<string>();
  return {
    started: (): readonly StartRecord[] => started,
    record: (jobs: readonly StatusFile[], now: Date): void =>
      recordJobs(launches, seen, jobs, now),
    spentLastHour: (now: Date): number => spentWithin(launches, now),
    launched: (start: StartRecord): void => {
      started = [...started.filter((s) => s.issue !== start.issue), start];
    },
    save: (now: Date): void =>
      writeLedger(file, {
        launches: keptLaunches(launches, seen, now),
        started: started.filter((s) => withinHour(s.at, now)),
      }),
  };
}

export type { Ledger, StartRecord };
export { openLedger };
