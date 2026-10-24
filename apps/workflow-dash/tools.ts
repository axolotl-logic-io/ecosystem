import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { z } from "zod";
import type { Snapshot } from "./data.ts";
import { detail, type ReadResult, summary } from "./tool-output.ts";
import { workflowRunDetails } from "./workflow-source.ts";

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
interface ToolSpec {
  name: string;
  label: string;
  description: string;
  legacy: boolean;
  single: boolean;
}
const referenceSchema = z.object({
  repo: z.string(),
  issue: z.number().int().positive(),
});
const specs: ToolSpec[] = [
  {
    name: "workflow_runs",
    label: "Workflow runs",
    description:
      "Read-only observed and uncertain workflow processes, capacity coverage, hold observation, installed and cached main SHA. No writes; task results and leases are not collected.",
    legacy: false,
    single: false,
  },
  {
    name: "workflow_run",
    label: "Workflow run",
    description:
      "Read-only launches and outcomes of a workflow run from local files; output capped to 12KB.",
    legacy: false,
    single: true,
  },
  {
    name: "pipeline_lanes",
    label: "Workflow runs (compatibility alias)",
    description:
      "Deprecated: use workflow_runs. Read-only compatibility output; performs no writes.",
    legacy: true,
    single: false,
  },
  {
    name: "pipeline_job",
    label: "Workflow run (compatibility alias)",
    description:
      "Deprecated: use workflow_run. Read-only compatibility output; capped to 12KB.",
    legacy: true,
    single: true,
  },
];
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
  if (!spec.single) {
    return summary(state, spec.legacy);
  }
  const reference = referenceSchema.parse(input);
  const run = state.workflowRuns.find(
    (item) =>
      item.repo === reference.repo &&
      item.issue === reference.issue &&
      item.data.history !== true,
  );
  if (run === undefined) {
    if (spec.legacy) {
      throw new Error("Job not found");
    }
    throw new Error("Workflow run not found");
  }
  return detail(run, await workflowRunDetails(run), spec.legacy);
}
function readTools(source: ReadSource): ReadTool[] {
  return specs.map((spec) => {
    let parameters: TSchema = Type.Object({});
    if (spec.single) {
      parameters = Type.Object({
        repo: Type.String(),
        issue: Type.Integer({ minimum: 1 }),
      });
    }
    return {
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters,
      annotations: { readOnlyHint: true },
      execute: (_id: string, input: unknown) => execute(spec, source, input),
    };
  });
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
