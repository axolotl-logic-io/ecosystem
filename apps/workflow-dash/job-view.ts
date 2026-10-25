import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { jobCondition } from "./job-conditions.ts";
import type { HistoricalJob } from "./job-history.ts";
import { elapsed, limit, timeline } from "./time.ts";
import {
  chip,
  durationBar,
  fmt,
  layout,
  pad,
  progress,
  shortRepo,
  stageInk,
} from "./ui-format.ts";

const rowSizes = {
  wideRepo: 19,
  repo: 15,
  smallRepo: 8,
  badge: 14,
  smallBadge: 4,
  issue: 5,
  smallIssue: 4,
  time: 8,
  smallTime: 7,
  bar: 8,
  smallBar: 4,
  separators: 5,
};
const launchChart = {
  labelMax: 22,
  labelMin: 9,
  labelFraction: 0.3,
  durationSpace: 13,
  minimumBar: 3,
  time: 8,
};
function jobLabel(run: HistoricalJob): string {
  return `${jobCondition(run)} ${shortRepo(run.repo)} #${run.issue} ${run.data.stage ?? "unknown"} ${run.data.launches.at(-1)?.key ?? "—"} ${fmt(elapsed(run.data.startedAt, run.data.endedAt ?? Date.now()))}`;
}
function jobRow(run: HistoricalJob, theme: Theme, width: number): string {
  const launch = run.data.launches.at(-1);
  const stage = run.data.stage ?? "wait";
  const timing = limit(launch?.key ?? "", launch?.startedAt ?? Date.now());
  let age = elapsed(run.data.startedAt, run.data.endedAt ?? Date.now());
  if (launch !== undefined) {
    age = timing.seconds;
  }
  let sizes = {
    repo: rowSizes.repo,
    badge: rowSizes.badge,
    issue: rowSizes.issue,
    time: rowSizes.time,
    bar: rowSizes.bar,
    prefix: 4,
  };
  let state = `${theme.fg("muted", jobCondition(run).slice(0, 1))} `;
  let badge = stage;
  if (width < layout.narrow) {
    sizes = {
      repo: rowSizes.smallRepo,
      badge: rowSizes.smallBadge,
      issue: rowSizes.smallIssue,
      time: rowSizes.smallTime,
      bar: rowSizes.smallBar,
      prefix: 2,
    };
    state = "";
    badge = badge.slice(0, rowSizes.smallBadge);
  } else if (width >= layout.medium) {
    sizes.repo = rowSizes.wideRepo;
  }
  const stepWidth = Math.max(
    1,
    width -
      (sizes.prefix +
        sizes.repo +
        sizes.issue +
        sizes.badge +
        2 +
        sizes.bar +
        sizes.time +
        rowSizes.separators),
  );
  let fallback = "waiting";
  if (run.data.history === true) {
    fallback = "history";
  }
  let bar = theme.fg("dim", "─".repeat(sizes.bar));
  let budget = timing.limit;
  if (budget === 0) {
    budget = limit(stage, 0, 0).limit;
  }
  if (budget > 0 && run.live === true) {
    bar = progress(theme, age / budget, sizes.bar);
  }
  return `${state}${theme.fg("accent", "\uea62")} ${pad(shortRepo(run.repo), sizes.repo)} ${pad(`#${run.issue}`, sizes.issue, true)} ${chip(theme, pad(badge, sizes.badge), stageInk(stage))} ${pad(launch?.key ?? fallback, stepWidth)} ${bar} ${theme.fg("muted", pad(fmt(age), sizes.time, true))}`;
}
function compactRunRow(
  run: HistoricalJob,
  theme: Theme,
  width: number,
): string {
  const columns = {
    repo: 9,
    wideRepo: 14,
    roomy: 50,
    issue: 5,
    duration: 9,
    reserved: 12,
  };
  let repoWidth = columns.repo;
  if (width >= columns.roomy) {
    repoWidth = columns.wideRepo;
  }
  const text = `${theme.fg("muted", jobCondition(run).slice(0, 1))} ${theme.fg("accent", "\uea62")} ${pad(shortRepo(run.repo), repoWidth)} ${pad(`#${run.issue}`, columns.issue, true)} ${chip(theme, run.data.stage ?? "wait", stageInk(run.data.stage ?? ""))} ${theme.fg("muted", run.data.launches.at(-1)?.key ?? "history")}`;
  const duration = fmt(
    elapsed(run.data.startedAt, run.data.endedAt ?? Date.now()),
  );
  return (
    pad(text, Math.max(1, width - columns.reserved)) +
    theme.fg("muted", pad(duration, columns.duration, true))
  );
}
function jobListRow(run: HistoricalJob, theme: Theme, width: number): string {
  let text = compactRunRow(run, theme, width);
  if (width >= layout.compactRun) {
    text = jobRow(run, theme, width - layout.panelInset);
  }
  if (run.data.history === true) {
    text = theme.style(text, { dim: true });
  }
  return text;
}
function launchBars(run: HistoricalJob, theme: Theme, width: number): string[] {
  const launches = timeline(run);
  const maximum = Math.max(1, ...launches.map((launch) => launch.seconds));
  const labelWidth = Math.min(
    launchChart.labelMax,
    Math.max(
      launchChart.labelMin,
      Math.floor(width * launchChart.labelFraction),
    ),
  );
  const barWidth = Math.max(
    launchChart.minimumBar,
    width - labelWidth - launchChart.durationSpace,
  );
  return launches.map(
    (launch) =>
      `${theme.fg(stageInk(launch.key), pad(launch.key, labelWidth))} ${durationBar(theme, launch.seconds / maximum, barWidth, stageInk(launch.key))} ${pad(fmt(launch.seconds), launchChart.time, true)}`,
  );
}
function jobDetailLines(
  run: HistoricalJob,
  theme: Theme,
  width: number,
): string[] {
  const lines = [
    theme.fg("accent", `\uea62 ${shortRepo(run.repo)} #${run.issue}`),
    `${theme.fg("muted", jobCondition(run))}  ${chip(theme, run.data.stage ?? "wait", stageInk(run.data.stage ?? ""))}  ${theme.fg("muted", fmt(elapsed(run.data.startedAt, run.data.endedAt ?? Date.now())))}`,
    "",
    `Historical job record · source stage ${run.data.stage ?? "not recorded"}`,
    ...wrapTextWithAnsi(
      "Retired job runtime evidence only: not the current workflow, mapped to no task, and linked to no buddy run or action run.",
      width,
    ),
    ...wrapTextWithAnsi(
      "A legacy job process observation verifies no lease, releases no resource and makes no capacity claim.",
      width,
    ),
    theme.fg("borderAccent", "LAUNCH TIMELINE · relative duration"),
    ...launchBars(run, theme, width),
    "",
    theme.fg("muted", "Enter  full timeline · verify pass/fail · stop reason"),
  ];
  if (run.data.history === true) {
    lines.push(
      theme.fg(
        "dim",
        "Historical launches unavailable after job.json replacement.",
      ),
    );
  }
  return lines;
}

export { jobDetailLines, jobLabel, jobListRow, jobRow, launchBars };
