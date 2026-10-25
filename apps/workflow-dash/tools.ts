import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { z } from "zod";
import type { Snapshot } from "./data.ts";
import { type HistoricalJob, jobDetails } from "./job-history.ts";
import {
  actionRunDetail,
  detail,
  type ReadResult,
  runtimeSummary,
  summary,
} from "./tool-output.ts";

interface ReadSource {
  active: () => boolean;
  refresh: () => Promise<void>;
  get: () => Snapshot;
}
interface ReadTool {
  name: string;
  label: string;
  description: string;
  annotations: { readOnlyHint: true };
  parameters: TSchema;
  execute: (id: string, params: unknown) => Promise<ReadResult>;
}
/**
 * What a read tool reports: buddy runtime observations, one action run, or
 * the retired job runtime's historical records (in the current or the
 * deprecated compatibility shape).
 */
type ToolReads =
  | "runtime runs"
  | "action run"
  | "job history"
  | "job record"
  | "legacy job history"
  | "legacy job record";
interface ToolSpec {
  name: string;
  label: string;
  description: string;
  reads: ToolReads;
}
const referenceSchema = z.object({
  repo: z.string(),
  issue: z.number().int().positive(),
});
const actionReferenceSchema = z.object({ id: z.string().min(1) });
const referenceParameters = Type.Object({
  repo: Type.String(),
  issue: Type.Integer({ minimum: 1 }),
});
const specs: ToolSpec[] = [
  {
    name: "buddy_runs",
    label: "Buddy runs",
    description:
      "Read-only buddy-run and action-run observations from local files, with their explicit links, unreadable files and coverage. Observations are never authority; no writes.",
    reads: "runtime runs",
  },
  {
    name: "action_run",
    label: "Action run",
    description:
      "Read-only whole action-run observation by id, with its buddy run, previous action run and session links; output capped to 12KB.",
    reads: "action run",
  },
  {
    name: "workflow_runs",
    label: "Job history",
    description:
      "Read-only historical job records from the retired job runtime, with legacy job process observations, hold observation, installed and cached main SHA. Not current runs; use buddy_runs.",
    reads: "job history",
  },
  {
    name: "workflow_run",
    label: "Job record",
    description:
      "Read-only launches and outcomes of one historical job record from local files; output capped to 12KB. Not a current run; use action_run.",
    reads: "job record",
  },
  {
    name: "pipeline_lanes",
    label: "Job history (compatibility alias)",
    description:
      "Deprecated: use buddy_runs, or workflow_runs for history. Retired job records only, in the old response shape; its capacity counts legacy job processes, not configured caps.",
    reads: "legacy job history",
  },
  {
    name: "pipeline_job",
    label: "Job record (compatibility alias)",
    description:
      "Deprecated: use action_run, or workflow_run for history. One retired job record in the old response shape; capped to 12KB.",
    reads: "legacy job record",
  },
];
function jobRecord(
  state: Snapshot,
  input: unknown,
  legacy: boolean,
): HistoricalJob {
  const reference = referenceSchema.parse(input);
  const run = state.jobHistory.find(
    (item) =>
      item.repo === reference.repo &&
      item.issue === reference.issue &&
      item.data.history !== true,
  );
  if (run === undefined) {
    if (legacy) {
      throw new Error("Job not found");
    }
    throw new Error("Job record not found");
  }
  return run;
}
async function execute(
  spec: ToolSpec,
  source: ReadSource,
  input: unknown,
): Promise<ReadResult> {
  if (!source.active()) {
    throw new Error("pipeline-dash not active");
  }
  await source.refresh();
  const state = source.get();
  switch (spec.reads) {
    case "runtime runs":
      return runtimeSummary(state.runtime, state.configWarnings);
    case "action run": {
      const { id } = actionReferenceSchema.parse(input);
      const entry = state.runtime.actionRuns.find((item) => item.run.id === id);
      if (entry === undefined) {
        throw new Error(
          "Action run not observed; see buddy_runs for unreadable files and coverage",
        );
      }
      return actionRunDetail(entry);
    }
    case "job history":
      return summary(state, false);
    case "legacy job history":
      return summary(state, true);
    case "job record": {
      const run = jobRecord(state, input, false);
      return detail(run, await jobDetails(run), false);
    }
    default: {
      const run = jobRecord(state, input, true);
      return detail(run, await jobDetails(run), true);
    }
  }
}
function parametersFor(reads: ToolReads): TSchema {
  if (reads === "action run") {
    return Type.Object({ id: Type.String({ minLength: 1 }) });
  }
  if (reads === "job record" || reads === "legacy job record") {
    return referenceParameters;
  }
  return Type.Object({});
}
function readTools(source: ReadSource): ReadTool[] {
  return specs.map((spec) => ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: parametersFor(spec.reads),
    annotations: { readOnlyHint: true },
    execute: (_id: string, input: unknown) => execute(spec, source, input),
  }));
}
function registerReadTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  source: ReadSource,
): void {
  for (const tool of readTools(source)) {
    pi.registerTool(tool);
  }
}

export type { ReadSource, ReadTool };
export { readTools, registerReadTools };
