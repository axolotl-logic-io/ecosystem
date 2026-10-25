import { type HistoricalJob, jobDetails } from "./job-history.ts";
import { fmt, plain } from "./ui-format.ts";

const chartWidth = 24;
const labelWidth = 22;
async function runReport(run: HistoricalJob): Promise<string> {
  const details = await jobDetails(run);
  const maximum = Math.max(
    1,
    ...details.timeline.map((launch) => launch.seconds),
  );
  const bars = details.timeline.map(
    (launch) =>
      `${launch.key.padEnd(labelWidth)} ${"▰".repeat(Math.max(1, Math.round((launch.seconds / maximum) * chartWidth))).padEnd(chartWidth, "▱")} ${fmt(launch.seconds)}`,
  );
  const launches = details.timeline.map(
    (launch) =>
      `${launch.key} ${launch.kind}\n  start ${launch.startedAt} · duration ${fmt(launch.seconds)} · outcome ${plain(launch.outcome)} · turns ${launch.turns ?? 0} · tokens ${plain(launch.usage ?? {})}`,
  );
  let { verify } = details;
  if (verify.length === 0) {
    verify = ["◷ No recognized verification summary in bounded log tails."];
  }
  return [
    `Historical job record · source stage ${run.data.stage ?? "unknown"}`,
    "Retired job runtime evidence only: not the current workflow, mapped to no task, and linked to no buddy run or action run.",
    "",
    "LAUNCH TIMELINE · relative durations",
    ...bars,
    "",
    ...launches,
    "",
    "Verify test.log summaries",
    ...verify,
    "",
    `Stop reason (local files): ${plain(details.stopReason)}`,
  ].join("\n");
}

export { runReport };
