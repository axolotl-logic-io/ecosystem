import { executionLabel, taskCoverage } from "./language.ts";
import { fmt, plain } from "./ui-format.ts";
import { type WorkflowRun, workflowRunDetails } from "./workflow-source.ts";

const chartWidth = 24;
const labelWidth = 22;
async function runReport(run: WorkflowRun): Promise<string> {
  const details = await workflowRunDetails(run);
  const maximum = Math.max(
    1,
    ...details.timeline.map((launch) => launch.seconds),
  );
  const bars = details.timeline.map(
    (launch) =>
      `${executionLabel(launch.key).padEnd(labelWidth)} ${"▰".repeat(Math.max(1, Math.round((launch.seconds / maximum) * chartWidth))).padEnd(chartWidth, "▱")} ${fmt(launch.seconds)}`,
  );
  const launches = details.timeline.map(
    (launch) =>
      `${executionLabel(launch.key)} ${launch.kind} · source key ${launch.key}\n  start ${launch.startedAt} · duration ${fmt(launch.seconds)} · outcome ${plain(launch.outcome)} · turns ${launch.turns ?? 0} · tokens ${plain(launch.usage ?? {})}`,
  );
  let { verify } = details;
  if (verify.length === 0) {
    verify = ["◷ No recognized verification summary in bounded log tails."];
  }
  return [
    `Source stage: ${run.data.stage ?? "unknown"}`,
    `Mapped tasks: ${taskCoverage(run.data.stage ?? "unknown").tasks.join(", ") || "unknown"}`,
    "Current task, binding and result: not observed; mapping is not execution evidence.",
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
