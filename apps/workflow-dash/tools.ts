import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MonitorSnapshot } from "@ecosystem/db/monitoring";
import type { MonitorEntity } from "@ecosystem/db/monitoring-protocol";
import { type TSchema, Type } from "typebox";
import { z } from "zod";
import {
  isTaskRun,
  newest,
  taskRunUsage,
  totalUsage,
} from "./monitor/model.ts";
import type { MonitorRuntime } from "./monitor/runtime.ts";

interface ReadSource {
  active: () => boolean;
  runtime: Pick<MonitorRuntime, "refresh" | "snapshot" | "error">;
}
interface ReadResult {
  content: { type: "text"; text: string }[];
  details: undefined;
}
interface ReadTool {
  name: string;
  label: string;
  description: string;
  annotations: { readOnlyHint: true };
  parameters: TSchema;
  execute: (id: string, params: unknown) => Promise<ReadResult>;
}
const maximumOutputCharacters = 12_000;
const truncatedOutputCharacters = 11_900;
const note =
  "Observations the collector recorded, never authority. A running state means the run's process was observed on the collector's host; unavailable means it was not.";
const filterSchema = z.strictObject({
  repo: z.string().min(1).optional(),
  issue: z.int().positive().optional(),
});

function result(value: unknown): ReadResult {
  let text = JSON.stringify(value, null, 2);
  if (text.length > maximumOutputCharacters) {
    text = `${text.slice(0, truncatedOutputCharacters)}\n[Truncated at 12KB; filter by repo and issue, or open /dash.]`;
  }
  return { content: [{ type: "text", text }], details: undefined };
}
function taskRunSummary(
  snapshot: MonitorSnapshot,
  run: MonitorEntity,
): Record<string, unknown> {
  const sessions = newest(
    snapshot.entities.filter(
      (item): boolean => item.kind === "session" && item.parent === run.id,
    ),
  );
  return {
    id: run.id,
    repo: run.repo,
    issue: run.issue,
    task: run.task,
    account: run.actor,
    step: run.phase,
    state: run.state,
    reason: run.reason,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    tokens: totalUsage(taskRunUsage(snapshot, run)),
    sessions: sessions.map((session) => {
      const usage = snapshot.usage.filter(
        (item): boolean => item.session === session.id,
      );
      return {
        id: session.id,
        key: session.title,
        state: session.state,
        context: usage.at(0)?.latest ?? null,
        tokens: totalUsage(usage),
      };
    }),
  };
}
async function execute(
  source: ReadSource,
  input: unknown,
): Promise<ReadResult> {
  if (!source.active()) {
    throw new Error("workflow-dash not active");
  }
  const filter = filterSchema.parse(input);
  await source.runtime.refresh();
  const { snapshot, error } = source.runtime;
  if (snapshot === null) {
    throw new Error(error ?? "Monitoring unavailable");
  }
  const collector = snapshot.entities.find(
    (item): boolean => item.id === "collector",
  );
  const runs = newest(
    snapshot.entities.filter(
      (item): boolean =>
        isTaskRun(item) &&
        (filter.repo === undefined || item.repo === filter.repo) &&
        (filter.issue === undefined || item.issue === filter.issue),
    ),
  );
  return result({
    note,
    collectedAt: collector?.activityAt ?? null,
    collection: collector?.state ?? "not collected",
    partial: snapshot.partial,
    taskRuns: runs.map((run) => taskRunSummary(snapshot, run)),
  });
}
function readTools(source: ReadSource): ReadTool[] {
  return [
    {
      name: "task_runs",
      label: "Task runs",
      description:
        "Read-only task runs from workflow monitoring, newest first: task, account, lifecycle step, state, outcome reason, sessions and token totals. Filter by repo (OWNER/REPO) and issue number. Observations are never authority; no writes; output capped to 12KB.",
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ minLength: 1 })),
        issue: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      annotations: { readOnlyHint: true },
      execute: (_id: string, input: unknown) => execute(source, input),
    },
  ];
}
function registerReadTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  source: ReadSource,
): void {
  for (const tool of readTools(source)) {
    pi.registerTool(tool);
  }
}

export type { ReadResult, ReadSource, ReadTool };
export { readTools, registerReadTools };
