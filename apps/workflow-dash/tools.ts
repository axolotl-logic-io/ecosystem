import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { z } from "zod";
import type { Snapshot } from "./data.ts";
import {
  actionRunDetail,
  type ReadResult,
  runtimeSummary,
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
/** What a read tool reports: buddy runtime observations or one action run. */
type ToolReads = "runtime runs" | "action run";
interface ToolSpec {
  name: string;
  label: string;
  description: string;
  reads: ToolReads;
}
const actionReferenceSchema = z.object({ id: z.string().min(1) });
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
  if (spec.reads === "runtime runs") {
    return runtimeSummary(state.runtime);
  }
  const { id } = actionReferenceSchema.parse(input);
  const entry = state.runtime.actionRuns.find((item) => item.run.id === id);
  if (entry === undefined) {
    throw new Error(
      "Action run not observed; see buddy_runs for unreadable files and coverage",
    );
  }
  return actionRunDetail(entry);
}
function parametersFor(reads: ToolReads): TSchema {
  if (reads === "action run") {
    return Type.Object({ id: Type.String({ minLength: 1 }) });
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
