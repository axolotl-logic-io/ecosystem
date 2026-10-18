// The usage report (`report.mjs usage`, src/report.ts): what the usage log's
// session records (src/job/usage-log.ts) say about how roles spend context.
// It groups sessions by role, state and model, flags the sessions worth a
// look, and names each role's tools with the most output. The flags only
// label the report; nothing acts on them. It does no I/O.

import type { IssueComment } from "../comments.ts";
import { USAGE_MARK } from "../comments.ts";
import { usageLines } from "../job/usage-comment.ts";
import type { UsageRecord, UsageRole } from "../job/usage-log.ts";
import { parseUsageLine } from "../job/usage-log.ts";

const MEDIAN = 0.5;
const P90 = 0.9;
const TOP_TOOLS = 5;

type SessionRecord = Extract<UsageRecord, { kind: "session" }>;

// Which records the report covers: the account that writes the usage
// comments, and optionally one role, one issue and records at or after a
// time.
interface ReportOptions {
  account: string;
  role: UsageRole | null;
  issue: number | null;
  since: string | null;
}

// The config's usageFlags: a first turn past `firstContext` tokens, or a
// largest tool output past `toolOutputShare` of the peak, is flagged.
interface UsageFlags {
  firstContext: number;
  toolOutputShare: number;
}

// The median, p90 and max of some sessions' values, by nearest rank.
interface Spread {
  median: number;
  p90: number;
  max: number;
}

interface Group {
  role: UsageRole;
  state: string;
  model: string;
  count: number;
  first: Spread;
  peak: Spread;
  tokens: Spread;
}

// Why a session is flagged: its first turn's context passed firstContext,
// its peak passed `soft` (only the installed version's records have one),
// its largest tool output passed toolOutputShare of
// the peak, or its first turn's context grew from the previous attempt's.
type FlagReason = "first-context" | "past-soft" | "tool-output" | "first-grew";

interface Flagged {
  issue: number;
  role: UsageRole;
  state: string;
  attempt: number;
  at: string;
  reasons: FlagReason[];
}

interface ToolTotal {
  tool: string;
  calls: number;
  outputChars: number;
}

interface Report {
  groups: Group[];
  flagged: Flagged[];
  tools: { role: UsageRole; top: ToolTotal[] }[];
}

// The value at nearest rank `p` of `values`, sorted ascending.
function rank(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

function spreadOf(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: rank(sorted, MEDIAN),
    p90: rank(sorted, P90),
    max: sorted.at(-1) ?? 0,
  };
}

function totalTokens(record: SessionRecord): number {
  const { input, output, cacheRead, cacheWrite } = record.tokens;
  return input + output + cacheRead + cacheWrite;
}

function wanted(record: UsageRecord, options: ReportOptions): boolean {
  const { role, issue, since } = options;
  return (
    record.kind === "session" &&
    (role === null || record.role === role) &&
    (issue === null || record.issue === issue) &&
    (since === null || Date.parse(record.at) >= Date.parse(since))
  );
}

// The session records in `comments` that `options` covers, oldest first.
function sessionsOf(
  comments: readonly IssueComment[],
  options: ReportOptions,
): SessionRecord[] {
  const sessions: SessionRecord[] = [];
  for (const { body, user } of comments) {
    if (user?.login === options.account && USAGE_MARK.test(body ?? "")) {
      for (const line of usageLines(body ?? "")) {
        const record = parseUsageLine(line);
        if (record?.kind === "session" && wanted(record, options)) {
          sessions.push(record);
        }
      }
    }
  }
  return sessions.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function groupsOf(sessions: readonly SessionRecord[]): Group[] {
  const keyed = new Map<string, SessionRecord[]>();
  for (const session of sessions) {
    const key = JSON.stringify([session.role, session.state, session.model]);
    keyed.set(key, [...(keyed.get(key) ?? []), session]);
  }
  const groups: Group[] = [];
  for (const group of keyed.values()) {
    const [head] = group;
    if (head !== undefined) {
      const { role, state, model } = head;
      groups.push({
        role,
        state,
        model,
        count: group.length,
        first: spreadOf(group.map(({ context }) => context.first)),
        peak: spreadOf(group.map(({ context }) => context.peak)),
        tokens: spreadOf(group.map(totalTokens)),
      });
    }
  }
  return groups.sort((a, b) =>
    `${a.role} ${a.state} ${a.model}`.localeCompare(
      `${b.role} ${b.state} ${b.model}`,
    ),
  );
}

function reasonsOf(
  session: SessionRecord,
  previous: SessionRecord | undefined,
  flags: UsageFlags,
): FlagReason[] {
  const { first, peak, soft } = session.context;
  const reasons: FlagReason[] = [];
  if (first > flags.firstContext) {
    reasons.push("first-context");
  }
  if (soft !== undefined && peak > soft) {
    reasons.push("past-soft");
  }
  const largest = session.largestToolOutput?.chars ?? 0;
  if (largest > flags.toolOutputShare * peak) {
    reasons.push("tool-output");
  }
  if (
    previous !== undefined &&
    session.attempt > previous.attempt &&
    first > previous.context.first
  ) {
    reasons.push("first-grew");
  }
  return reasons;
}

// The flagged sessions; a session's previous attempt is the latest earlier
// session of the same issue and state.
function flaggedOf(
  sessions: readonly SessionRecord[],
  flags: UsageFlags,
): Flagged[] {
  const last = new Map<string, SessionRecord>();
  const flagged: Flagged[] = [];
  for (const session of sessions) {
    const { issue, role, state, attempt, at } = session;
    const key = JSON.stringify([issue, state]);
    const reasons = reasonsOf(session, last.get(key), flags);
    last.set(key, session);
    if (reasons.length > 0) {
      flagged.push({ issue, role, state, attempt, at, reasons });
    }
  }
  return flagged;
}

function toolsOf(sessions: readonly SessionRecord[]): Report["tools"] {
  const byRole = new Map<UsageRole, Map<string, ToolTotal>>();
  for (const { role, tools } of sessions) {
    const totals = byRole.get(role) ?? new Map<string, ToolTotal>();
    for (const [tool, use] of Object.entries(tools)) {
      const sum = totals.get(tool) ?? { tool, calls: 0, outputChars: 0 };
      sum.calls += use.calls;
      sum.outputChars += use.outputChars;
      totals.set(tool, sum);
    }
    byRole.set(role, totals);
  }
  return [...byRole]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, totals]) => ({
      role,
      top: [...totals.values()]
        .sort(
          (a, b) =>
            b.outputChars - a.outputChars || a.tool.localeCompare(b.tool),
        )
        .slice(0, TOP_TOOLS),
    }));
}

// The report on the usage records in `comments` that `options` covers.
function usageReport(
  comments: readonly IssueComment[],
  options: ReportOptions,
  flags: UsageFlags,
): Report {
  const sessions = sessionsOf(comments, options);
  return {
    groups: groupsOf(sessions),
    flagged: flaggedOf(sessions, flags),
    tools: toolsOf(sessions),
  };
}

function spreadText({ median, p90, max }: Spread): string {
  return `${median}/${p90}/${max}`;
}

// The report as text for a terminal.
function formatReport(report: Report): string {
  const lines = [
    "Sessions by role, state and model (median/p90/max):",
    ...report.groups.map(
      (group) =>
        `  ${group.role} ${group.state} ${group.model}: ${group.count} sessions; first ${spreadText(group.first)}; peak ${spreadText(group.peak)}; tokens ${spreadText(group.tokens)}`,
    ),
    "Flagged sessions:",
    ...report.flagged.map(
      (flag) =>
        `  #${flag.issue} ${flag.role} ${flag.state} attempt ${flag.attempt} at ${flag.at}: ${flag.reasons.join(", ")}`,
    ),
    "Tools with the most output, per role:",
    ...report.tools.map(
      ({ role, top }) =>
        `  ${role}: ${top.map((tool) => `${tool.tool} ${tool.outputChars} chars in ${tool.calls} calls`).join("; ")}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export type {
  Flagged,
  FlagReason,
  Group,
  Report,
  ReportOptions,
  Spread,
  UsageFlags,
};
export { formatReport, usageReport };
