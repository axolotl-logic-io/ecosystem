import { z } from "zod";
import type { Snapshot } from "../data.ts";
import type { ReadResult } from "../tool-output.ts";
import { type ReadTool, readTools } from "../tools.ts";
import type { WorkflowRun } from "../workflow-source.ts";
import { makeRun, makeState } from "./model-fixtures.ts";

const fixtureIssue = 2;
const fixturePid = 123;
const times = { start: 1000, end: 2000 };
const toolNames = [
  "workflow_runs",
  "workflow_run",
  "pipeline_lanes",
  "pipeline_job",
];
const taskSchema = z
  .object({ currentTask: z.null(), tasks: z.array(z.string()) })
  .passthrough();
const evidenceSchema = z.object({
  id: z.string(),
  sourceStage: z.string(),
  stageLabel: z.string(),
  processObservation: z.string(),
  taskCoverage: taskSchema,
});
const summarySchema = z
  .object({
    capacity: z.object({
      observedProcesses: z.number(),
      unknownProcesses: z.number(),
      configuredLimit: z.null(),
      source: z.string(),
    }),
    runs: z.array(evidenceSchema.extend({ launch: z.string() })),
    coverage: z.string(),
  })
  .passthrough();
const detailSchema = evidenceSchema
  .extend({
    outcome: z.unknown(),
    launches: z.array(
      z.object({ key: z.string(), label: z.string(), seconds: z.number() }),
    ),
  })
  .passthrough();
interface ToolHarness {
  tools: ReadonlyMap<string, ReadTool>;
  state: Snapshot;
  run: WorkflowRun;
  invoke: (name: string, input?: unknown) => Promise<ReadResult>;
  read: (name: string, input?: unknown) => Promise<unknown>;
  deactivate: () => void;
  refreshes: () => number;
}
function harness(): ToolHarness {
  let active = true;
  let refreshes = 0;
  const run = makeRun(
    {
      id: "source-run-id",
      stage: "implement",
      pid: fixturePid,
      startedAt: times.start,
      endedAt: times.end,
      outcome: null,
      launches: [
        { key: "implementor-1", kind: "session", startedAt: times.start },
      ],
    },
    { repo: "org/repo", issue: fixtureIssue },
  );
  const state = makeState({ workflowRuns: [run] });
  const tools = new Map(
    readTools({
      active: () => active,
      refresh: () => {
        refreshes += 1;
        return Promise.resolve();
      },
      get: () => state,
    }).map((tool) => [tool.name, tool]),
  );
  function invoke(name: string, input: unknown = {}): Promise<ReadResult> {
    const tool = tools.get(name);
    if (tool === undefined) {
      throw new Error(`Unknown test tool ${name}`);
    }
    return tool.execute("test", input);
  }
  async function read(name: string, input: unknown = {}): Promise<unknown> {
    const output = await invoke(name, input);
    const value: unknown = JSON.parse(output.content[0].text);
    return value;
  }
  return {
    tools,
    state,
    run,
    invoke,
    read,
    deactivate: (): void => {
      active = false;
    },
    refreshes: () => refreshes,
  };
}

export type { ToolHarness };
export {
  detailSchema,
  fixtureIssue,
  fixturePid,
  harness,
  summarySchema,
  toolNames,
};
