import type { MonitorSnapshot, UsageSummary } from "@ecosystem/db/monitoring";
import type { MonitorEntity } from "@ecosystem/db/monitoring-protocol";

interface WorkRow {
  id: string;
  section: string;
  item: MonitorEntity;
  action: MonitorEntity | null;
  session: MonitorEntity | null;
  state: string;
  reason: string | null;
}
const thousand = 1000;
const million = 1_000_000;
const secondsPerMinute = 60;
const secondsPerHour = 3600;
const live = new Set(["running", "waiting", "queued", "pending"]);
const attention = new Set([
  "failed",
  "refused",
  "unknown",
  "blocked",
  "status unavailable",
  "rejected",
  "partial",
  "paused",
]);
function newest(items: MonitorEntity[]): MonitorEntity[] {
  return [...items].sort(
    (a, b): number =>
      (b.startedAt ?? b.sourceAt).localeCompare(a.startedAt ?? a.sourceAt) ||
      a.id.localeCompare(b.id),
  );
}
function workRows(
  snapshot: MonitorSnapshot,
  repo: string | null,
  now: number,
): WorkRow[] {
  const entities = snapshot.entities.filter(
    (item): boolean => repo === null || item.repo === repo,
  );
  const actions = newest(
    entities.filter((item): boolean => item.kind === "action"),
  );
  const work = entities.filter((item): boolean => item.kind === "work");
  for (const action of actions) {
    if (
      !work.some(
        (item): boolean =>
          item.repo === action.repo && item.issue === action.issue,
      )
    ) {
      work.push({
        ...action,
        id: `${action.repo}#${action.issue}`,
        kind: "work",
        state: "unknown",
        title: "Issue details unavailable",
      });
    }
  }
  const rows = work.flatMap((item): WorkRow[] => {
    const action =
      actions.find(
        (candidate): boolean =>
          candidate.repo === item.repo && candidate.issue === item.issue,
      ) ?? null;
    const sessions = newest(
      entities.filter(
        (candidate): boolean =>
          candidate.kind === "session" && candidate.parent === action?.id,
      ),
    );
    const session =
      sessions.find((candidate): boolean => candidate.endedAt === null) ??
      sessions.at(0) ??
      null;
    let section = "PENDING";
    let state = "Awaiting start";
    let { reason } = item;
    if (action !== null) {
      ({ state, reason } = action);
      if (live.has(state)) {
        section = "ACTIVE";
      } else if (attention.has(state)) {
        section = "NEEDS YOU";
      } else if (state === "succeeded" && action.task === "land") {
        section = "FINISHED";
        state = "Landed";
      } else if (state === "succeeded") {
        state = `${action.task ?? "Task"} finished`;
        reason = "Next task depends on runtime prerequisites";
      } else if (state === "stopped") {
        state = "Stopped";
        section = "NEEDS YOU";
      }
    }
    if (item.state === "closed") {
      section = "FINISHED";
      if (state !== "Landed") {
        state = "Closed";
      }
    }
    if (
      section === "FINISHED" &&
      !sameDay(item.endedAt ?? action?.endedAt, now)
    ) {
      return [];
    }
    return [{ id: item.id, section, item, action, session, state, reason }];
  });
  const standalone = entities
    .filter((item): boolean => item.kind === "session" && item.parent === null)
    .flatMap((session): WorkRow[] => {
      let section = "SUBAGENTS";
      if (
        !(
          live.has(session.state) ||
          attention.has(session.state) ||
          sameDay(session.endedAt, now)
        )
      ) {
        return [];
      }
      if (attention.has(session.state)) {
        section = "NEEDS YOU";
      }
      return [
        {
          id: session.id,
          section,
          item: session,
          action: null,
          session,
          state: session.state,
          reason: session.reason,
        },
      ];
    });
  rows.push(...standalone);
  const order = ["ACTIVE", "NEEDS YOU", "PENDING", "SUBAGENTS", "FINISHED"];
  return rows.sort(
    (a, b): number =>
      order.indexOf(a.section) - order.indexOf(b.section) ||
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
function notices(snapshot: MonitorSnapshot, repo: string | null): string[] {
  const buddies = newest(
    snapshot.entities.filter((item): boolean => item.kind === "buddy"),
  );
  const latest = new Map<string, MonitorEntity>();
  for (const buddy of buddies) {
    const key = buddy.actor ?? buddy.title;
    if (!latest.has(key)) {
      latest.set(key, buddy);
    }
  }
  const activeParents = new Set(
    [...latest.values()].map((buddy): string => buddy.id),
  );
  const lines = snapshot.entities
    .filter(
      (item): boolean =>
        item.kind === "health" &&
        (repo === null || item.repo === null || item.repo === repo) &&
        (item.parent === null || activeParents.has(item.parent)) &&
        ["held", "waiting", "failed", "partial"].includes(item.state),
    )
    .flatMap((item): string[] => {
      if (item.reason === null) {
        return [];
      }
      // The collector's own reason holds several warnings, one per line.
      const reasons = item.reason.split("\n").filter(Boolean);
      if (item.id === "collector") {
        return reasons;
      }
      return reasons.map((reason): string => `${item.title}: ${reason}`);
    });
  for (const buddy of latest.values()) {
    if (["stale", "unknown", "stopped", "ended"].includes(buddy.state)) {
      lines.push(
        `${buddy.title}: ${buddy.state} · ${buddy.reason ?? "No active runtime"}`,
      );
    }
  }
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
function actionUsage(
  snapshot: MonitorSnapshot,
  action: MonitorEntity,
): UsageSummary[] {
  const ids = new Set(
    snapshot.entities
      .filter(
        (item): boolean => item.kind === "session" && item.parent === action.id,
      )
      .map((item): string => item.id),
  );
  return snapshot.usage.filter((item): boolean => ids.has(item.session));
}

export type { WorkRow };
export {
  actionUsage,
  compactNumber,
  elapsed,
  newest,
  notices,
  totalUsage,
  workRows,
};
