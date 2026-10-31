import type { MonitorSnapshot, UsageSummary } from "@ecosystem/db/monitoring";
import type { MonitorEntity } from "@ecosystem/db/monitoring-protocol";
import { taskRunKind } from "./records.ts";

/**
 * One row of the work view: an issue with its newest task run and that
 * run's newest session, or a generic subagent session on its own.
 */
interface WorkRow {
  id: string;
  section: string;
  item: MonitorEntity;
  taskRun: MonitorEntity | null;
  session: MonitorEntity | null;
  state: string;
  reason: string | null;
}
const thousand = 1000;
const million = 1_000_000;
const secondsPerMinute = 60;
const secondsPerHour = 3600;
const live = new Set(["running"]);
const attention = new Set(["failed", "stopped", "unavailable"]);
// Generic subagent run states, which are not task run states.
const subagentLive = new Set(["running", "waiting", "queued", "pending"]);
const subagentAttention = new Set([
  "failed",
  "unknown",
  "blocked",
  "rejected",
  "partial",
  "paused",
]);
const sections = ["ACTIVE", "NEEDS YOU", "OPEN", "SUBAGENTS", "FINISHED"];
function newest(items: MonitorEntity[]): MonitorEntity[] {
  return [...items].sort(
    (a, b): number =>
      (b.startedAt ?? b.sourceAt).localeCompare(a.startedAt ?? a.sourceAt) ||
      a.id.localeCompare(b.id),
  );
}
function isTaskRun(item: MonitorEntity): boolean {
  return item.kind === taskRunKind;
}
function issueRow(
  item: MonitorEntity,
  taskRuns: MonitorEntity[],
  entities: MonitorEntity[],
  now: number,
): WorkRow[] {
  const taskRun =
    taskRuns.find(
      (candidate): boolean =>
        candidate.repo === item.repo && candidate.issue === item.issue,
    ) ?? null;
  const sessions = newest(
    entities.filter(
      (candidate): boolean =>
        candidate.kind === "session" && candidate.parent === taskRun?.id,
    ),
  );
  const session =
    sessions.find((candidate): boolean => candidate.endedAt === null) ??
    sessions.at(0) ??
    null;
  let section = "OPEN";
  let state = "No task run";
  let reason: string | null = null;
  if (taskRun !== null) {
    ({ state, reason } = taskRun);
    if (live.has(state)) {
      section = "ACTIVE";
    } else if (attention.has(state)) {
      section = "NEEDS YOU";
    }
  }
  if (item.state === "closed") {
    section = "FINISHED";
    state = "Closed";
    reason = null;
    if (!sameDay(item.endedAt, now)) {
      return [];
    }
  }
  return [{ id: item.id, section, item, taskRun, session, state, reason }];
}
function workRows(
  snapshot: MonitorSnapshot,
  repo: string | null,
  now: number,
): WorkRow[] {
  const entities = snapshot.entities.filter(
    (item): boolean => repo === null || item.repo === repo,
  );
  const taskRuns = newest(entities.filter(isTaskRun));
  const work = entities.filter((item): boolean => item.kind === "work");
  for (const taskRun of taskRuns) {
    if (
      !work.some(
        (item): boolean =>
          item.repo === taskRun.repo && item.issue === taskRun.issue,
      )
    ) {
      work.push({
        ...taskRun,
        id: `${taskRun.repo}#${taskRun.issue}`,
        kind: "work",
        state: "unknown",
        title: "Issue details unavailable",
        reason: null,
      });
    }
  }
  const rows = work.flatMap((item): WorkRow[] =>
    issueRow(item, taskRuns, entities, now),
  );
  const standalone = entities
    .filter((item): boolean => item.kind === "session" && item.parent === null)
    .flatMap((session): WorkRow[] => {
      let section = "SUBAGENTS";
      if (subagentAttention.has(session.state)) {
        section = "NEEDS YOU";
      } else if (
        !(subagentLive.has(session.state) || sameDay(session.endedAt, now))
      ) {
        return [];
      }
      return [
        {
          id: session.id,
          section,
          item: session,
          taskRun: null,
          session,
          state: session.state,
          reason: session.reason,
        },
      ];
    });
  rows.push(...standalone);
  return rows.sort(
    (a, b): number =>
      sections.indexOf(a.section) - sections.indexOf(b.section) ||
      b.item.sourceAt.localeCompare(a.item.sourceAt) ||
      a.id.localeCompare(b.id),
  );
}
function sameDay(at: string | null | undefined, now: number): boolean {
  if (at === null || at === undefined) {
    return false;
  }
  return new Date(at).toDateString() === new Date(now).toDateString();
}
/** Collection problems: the collector's own warnings and failed GitHub reads. */
function notices(snapshot: MonitorSnapshot, repo: string | null): string[] {
  const lines = snapshot.entities
    .filter(
      (item): boolean =>
        item.kind === "health" &&
        (repo === null || item.repo === null || item.repo === repo) &&
        ["failed", "partial"].includes(item.state),
    )
    .flatMap((item): string[] => {
      if (item.reason === null) {
        return [];
      }
      // The collector's own reason lists several warnings, one per line.
      const reasons = item.reason.split("\n").filter(Boolean);
      if (item.id === "collector") {
        return reasons;
      }
      return reasons.map((reason): string => `${item.title}: ${reason}`);
    });
  return [...new Set(lines)];
}
function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (value >= million) {
    return `${(value / million).toFixed(1)}m`;
  }
  if (value >= thousand) {
    return `${Math.round(value / thousand)}k`;
  }
  return String(value);
}
function elapsed(at: string | null | undefined, now: number): string {
  if (at === null || at === undefined) {
    return "—";
  }
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / thousand));
  if (seconds < secondsPerMinute) {
    return `${seconds}s`;
  }
  if (seconds < secondsPerHour) {
    return `${Math.floor(seconds / secondsPerMinute)}m`;
  }
  return `${Math.floor(seconds / secondsPerHour)}h ${Math.floor((seconds % secondsPerHour) / secondsPerMinute)}m`;
}
function totalUsage(usage: UsageSummary[]): number | null {
  const measured = usage.filter((item): boolean => item.input !== null);
  if (measured.length === 0) {
    return null;
  }
  return measured.reduce(
    (sum, item): number =>
      sum +
      (item.input ?? 0) +
      (item.output ?? 0) +
      (item.cacheRead ?? 0) +
      (item.cacheWrite ?? 0),
    0,
  );
}
/** The usage of every session that names `taskRun` as its parent. */
function taskRunUsage(
  snapshot: MonitorSnapshot,
  taskRun: MonitorEntity,
): UsageSummary[] {
  const ids = new Set(
    snapshot.entities
      .filter(
        (item): boolean =>
          item.kind === "session" && item.parent === taskRun.id,
      )
      .map((item): string => item.id),
  );
  return snapshot.usage.filter((item): boolean => ids.has(item.session));
}

export type { WorkRow };
export {
  compactNumber,
  elapsed,
  isTaskRun,
  newest,
  notices,
  sections,
  taskRunUsage,
  totalUsage,
  workRows,
};
