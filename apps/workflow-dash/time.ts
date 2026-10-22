import { executionLabel, stageLabel } from "./language.ts";
import type {
  JournalRecord,
  Launch,
  SessionRecord,
  Timestamp,
} from "./source-records.ts";
import type { WorkflowRun } from "./workflow-source.ts";

const millisecondsPerSecond = 1000;
const secondsPerMinute = 60;
const developerBudgetMinutes = 60;
const otherBudgetMinutes = 30;
const warningFraction = 0.8;
const developerKey = /^(?:developer|implementor|implement)(?:-|$)/u;
const authorReviewerKey = /^(?:reviewer|author|review)(?:-|$)/u;
const launchNumber = /-\d+$/u;
type TimedLaunch = Launch & { seconds: number };
interface SessionTime {
  model: number;
  tool: number;
}
interface TimeBreakdown {
  launches: Record<string, number>;
  types: Record<string, number>;
}

function ms(value: Timestamp): number {
  if (typeof value === "number") {
    return value;
  }
  if (value === undefined || value === null) {
    return 0;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return parsed;
}
function today(value: Timestamp, now = Date.now()): boolean {
  return new Date(ms(value)).toDateString() === new Date(now).toDateString();
}
function seconds(start: Timestamp, end: Timestamp): number {
  return Math.max(0, (ms(end) - ms(start)) / millisecondsPerSecond);
}
function elapsed(start: Timestamp, end: Timestamp = Date.now()): number {
  return seconds(start, end);
}
/** Historical display references, not installed policy or attempt budgets. */
function limit(
  key: string,
  start: Timestamp,
  now = Date.now(),
): { seconds: number; limit: number; warning: boolean } {
  let minutes = 0;
  if (developerKey.test(key)) {
    minutes = developerBudgetMinutes;
  } else if (authorReviewerKey.test(key)) {
    minutes = otherBudgetMinutes;
  }
  const budget = minutes * secondsPerMinute;
  const used = elapsed(start, now);
  return {
    seconds: used,
    limit: budget,
    warning: budget > 0 && used >= budget * warningFraction,
  };
}
function timeline(run: WorkflowRun, now = Date.now()): TimedLaunch[] {
  return run.data.launches.map((launch, index, launches) => {
    let end = launch.lastEventAt ?? launch.startedAt;
    if (run.live === true) {
      end = now;
    }
    end = launches[index + 1]?.startedAt ?? run.data.endedAt ?? end;
    return { ...launch, seconds: seconds(launch.startedAt, end) };
  });
}
function sessionTime(records: SessionRecord[]): SessionTime {
  const totals: SessionTime = { model: 0, tool: 0 };
  let previous = 0;
  for (const record of records) {
    const time = ms(record.message.timestamp ?? record.timestamp);
    if (previous > 0 && time >= previous) {
      const delta = (time - previous) / millisecondsPerSecond;
      if (record.message.role === "toolResult") {
        totals.tool += delta;
      } else {
        totals.model += delta;
      }
    }
    previous = time;
  }
  return totals;
}
function launchTotals(run: WorkflowRun, now: number): Record<string, number> {
  const totals: Record<string, number> = {};
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  for (const launch of timeline(run, now)) {
    const start = ms(launch.startedAt);
    const end = start + launch.seconds * millisecondsPerSecond;
    const duration =
      Math.max(0, Math.min(now, end) - Math.max(midnight, start)) /
      millisecondsPerSecond;
    const key = `${launch.kind}/${executionLabel(launch.key).replace(launchNumber, "")}`;
    if (duration > 0) {
      totals[key] = (totals[key] ?? 0) + duration;
    }
  }
  return totals;
}
function journalTotals(
  records: JournalRecord[],
  now: number,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const record of records.filter(
    (entry) => entry.kind === "job" && today(entry.at, now),
  )) {
    let label = stageLabel(record.role ?? "unknown");
    if (typeof record.stages === "string") {
      label = stageLabel(record.stages);
    }
    if (Array.isArray(record.stages)) {
      label = record.stages.map(stageLabel).join(" → ");
    }
    totals[label] = (totals[label] ?? 0) + (record.seconds ?? 0);
  }
  return totals;
}
function timeBreakdown(runs: WorkflowRun[], now = Date.now()): TimeBreakdown {
  const totals: TimeBreakdown = { launches: {}, types: {} };
  for (const run of runs) {
    for (const [key, duration] of Object.entries(launchTotals(run, now))) {
      totals.launches[key] = (totals.launches[key] ?? 0) + duration;
    }
    for (const [key, duration] of Object.entries(
      journalTotals(run.records, now),
    )) {
      totals.types[key] = (totals.types[key] ?? 0) + duration;
    }
  }
  return totals;
}

export type { SessionTime, TimeBreakdown, TimedLaunch };
export {
  elapsed,
  limit,
  ms,
  seconds,
  sessionTime,
  timeBreakdown,
  timeline,
  today,
};
