import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { HistoricalJob } from "./job-history.ts";
import { timeBreakdown } from "./time.ts";
import { durationBar, fmt, pad } from "./ui-format.ts";

const chartSizes = {
  labelMax: 38,
  labelMin: 10,
  labelFraction: 0.35,
  barMax: 40,
  barMin: 3,
  durationSpace: 19,
  percent: 6,
  time: 8,
  percentScale: 100,
};
type ChartScope = "all" | "launches" | "types";
function chart(
  theme: Theme,
  values: Record<string, number>,
  width: number,
): string[] {
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  const labelWidth = Math.min(
    chartSizes.labelMax,
    Math.max(chartSizes.labelMin, Math.floor(width * chartSizes.labelFraction)),
  );
  const barWidth = Math.min(
    chartSizes.barMax,
    Math.max(chartSizes.barMin, width - labelWidth - chartSizes.durationSpace),
  );
  if (total === 0) {
    return [theme.fg("muted", "◷ No time recorded today")];
  }
  return Object.entries(values)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([key, value]) =>
        `${pad(key, labelWidth)} ${durationBar(theme, value / total, barWidth)} ${pad(`${((value / total) * chartSizes.percentScale).toFixed(1)}%`, chartSizes.percent, true)} ${theme.fg("muted", pad(fmt(value), chartSizes.time, true))}`,
    );
}
function charts(
  theme: Theme,
  data: { runs: HistoricalJob[]; sessions: string; scope: ChartScope },
  width: number,
): string[] {
  const breakdown = timeBreakdown(data.runs);
  const lines: string[] = [];
  if (data.scope !== "types") {
    lines.push(
      theme.fg("borderAccent", "LAUNCH KIND · historical job launch snapshots"),
      "",
      ...chart(theme, breakdown.launches, width),
      "",
    );
  }
  if (data.scope !== "launches") {
    lines.push(
      theme.fg(
        "borderAccent",
        "SOURCE STAGES · today's historical job journal",
      ),
      "",
      ...chart(theme, breakdown.types, width),
      "",
      theme.fg(
        "borderAccent",
        "SESSION DELTAS · approximate / bounded log tails",
      ),
    );
    const start = data.sessions.indexOf("Session timestamp");
    let text = data.sessions;
    if (start >= 0) {
      text = text.slice(start);
    }
    lines.push(
      ...wrapTextWithAnsi(text, width).map((line) => theme.fg("muted", line)),
    );
  }
  return lines;
}

export type { ChartScope };
export { charts };
