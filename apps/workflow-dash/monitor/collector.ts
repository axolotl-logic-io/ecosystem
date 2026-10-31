import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Database } from "@ecosystem/db";
import { appendBatch, cursor, saveEntity } from "@ecosystem/db/monitoring";
import type { MonitorEvent } from "@ecosystem/db/monitoring-protocol";
import { z } from "zod";
import { collect } from "../collection.ts";
import type { Config } from "../config.ts";
import { newestDirs, readWhole, safePath } from "../local-files.ts";
import { parse } from "../source-records.ts";
import {
  loadTaskRuns,
  type TaskRun,
  type TaskRunSession,
} from "../task-runs.ts";
import {
  entity,
  projectRecord,
  safeBody,
  taskRunKind,
  timestamp,
} from "./records.ts";

const execute = promisify(execFile);
const chunkBytes = 2_097_152;
const statusBytes = 1_048_576;
const maxEvents = 2000;
const runLimit = 200;
const issueLimit = 1000;
const githubTimeout = 30_000;
const githubBuffer = 4_194_304;
const lf = 10;
// The labels that start, stop or show the runs of tasks.
const workflowLabel = /^(?:start:[\w-]+|agent:[\w-]+:running|agents:stop)$/u;
const itemSchema = z.object({
  number: z.int().positive(),
  title: z.string(),
  state: z.string(),
  updatedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  labels: z.array(z.object({ name: z.string() })),
});
const genericStep = z.object({
  index: z.int().nonnegative().optional(),
  agent: z.string().optional(),
  task: z.string().optional(),
  model: z.string().optional(),
  status: z.string().optional(),
  lastActivityAt: z.number().optional(),
  contextLimit: z.int().positive().optional(),
});
const genericRun = z.object({
  id: z.string(),
  state: z.string(),
  task: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  lastUpdate: z.number().optional(),
  steps: z.array(genericStep).optional(),
  error: z.string().optional(),
});
const stepEvent = z.object({
  subagentRunId: z.string(),
  subagentStepIndex: z.int().nonnegative(),
});
interface CollectionResult {
  warnings: string[];
}
interface StreamOptions {
  root: string;
  session: (record: unknown) => string | null;
}
interface Collector {
  db: Database;
  config: Config;
  /** The task apps' runs folder. */
  runs: string;
  warnings: string[];
}

async function ingestStream(
  db: Database,
  path: string,
  options: StreamOptions,
): Promise<boolean> {
  // O_RDONLY is zero. O_NOFOLLOW opens read-only and refuses a linked final component.
  const resolved = await safePath(path);
  const root = await realpath(options.root);
  if (!resolved.startsWith(`${root}/`)) {
    throw new Error("Transcript escapes its configured source root");
  }
  const file = await open(path, constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) {
      throw new Error("Transcript must be a regular file");
    }
    const source = createHash("sha256")
      .update(`${path}:${info.dev}:${info.ino}:${info.birthtimeMs}`)
      .digest("hex");
    const offset = await cursor(db, source);
    if (offset > info.size) {
      throw new Error("Transcript shrank; ingestion stopped without replay");
    }
    const buffer = Buffer.alloc(Math.min(chunkBytes, info.size - offset));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const events: MonitorEvent[] = [];
    let start = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === lf) {
        const value = parse(buffer.subarray(start, index).toString("utf8"));
        if (value === null) {
          throw new Error(
            "Malformed transcript line; ingestion stopped at the last committed batch",
          );
        }
        const session = options.session(value);
        if (session !== null) {
          const event = projectRecord(value, session, source, offset + start);
          if (event !== null) {
            events.push(event);
          }
        }
        start = index + 1;
        if (events.length >= maxEvents) {
          break;
        }
      }
    }
    if (start === 0 && bytesRead === chunkBytes) {
      throw new Error("Transcript record exceeds the 2 MiB ingestion bound");
    }
    if (start > 0) {
      await appendBatch(db, { source, offset, next: offset + start, events });
    }
    return offset + start < info.size;
  } finally {
    await file.close();
  }
}
async function sourceTime(path: string): Promise<string> {
  return (await stat(path)).mtime.toISOString();
}
async function importTaskRun(at: Collector, run: TaskRun): Promise<void> {
  const { record } = run;
  const sourceAt = await sourceTime(run.path);
  await saveEntity(
    at.db,
    entity({
      id: record.id,
      kind: taskRunKind,
      repo: record.workItem.repo,
      issue: record.workItem.number,
      title: `#${record.workItem.number}`,
      state: run.state,
      task: record.task,
      phase: record.step,
      actor: record.account,
      sourceAt,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      reason: run.reason,
    }),
  );
  await collect(
    run.sessions,
    (session): Promise<void> => importSession(at, run, session, sourceAt),
  );
}
// A task run's model session, named by its transcript's key.
async function importSession(
  at: Collector,
  run: TaskRun,
  session: TaskRunSession,
  sourceAt: string,
): Promise<void> {
  const { record } = run;
  const id = `${record.id}:${session.key}`;
  let state: string = run.state;
  if (record.state === "ended") {
    state = "ended";
  }
  await saveEntity(
    at.db,
    entity({
      id,
      kind: "session",
      parent: record.id,
      repo: record.workItem.repo,
      issue: record.workItem.number,
      title: session.key,
      actor: record.account,
      task: record.task,
      state,
      endedAt: record.endedAt,
      activityAt: await sourceTime(session.transcript),
      sourceAt,
    }),
  );
  try {
    if (
      await ingestStream(at.db, session.transcript, {
        root: at.runs,
        session: (): string => id,
      })
    ) {
      at.warnings.push(`Transcript catching up for session ${id}`);
    }
  } catch {
    at.warnings.push(
      `Transcript ingestion failed for session ${id}; inspect its append-only source`,
    );
  }
}
async function collectTaskRuns(at: Collector): Promise<void> {
  const taskRuns = await loadTaskRuns(at.runs, at.config.repos);
  if (taskRuns.omitted > 0 || taskRuns.problems.length > 0) {
    at.warnings.push(
      "Some task run records are unreadable or outside collection bounds",
    );
  }
  await collect(taskRuns.runs, (run): Promise<void> => importTaskRun(at, run));
}
async function importGeneric(at: Collector, directory: string): Promise<void> {
  const folder = join(at.config.subagentRuns, directory);
  const path = join(folder, "status.json");
  const file = await readWhole(path, statusBytes);
  if (file.state !== "read") {
    at.warnings.push("A subagent status is unreadable");
    return;
  }
  const parsed = genericRun.safeParse(parse(file.text));
  if (!parsed.success || parsed.data.id !== directory) {
    at.warnings.push("A subagent status is invalid");
    return;
  }
  const run = parsed.data;
  const sourceAt = timestamp(run.lastUpdate) ?? (await sourceTime(path));
  const steps = run.steps ?? [{ index: 0 }];
  const indices = new Set<number>();
  await collect(
    [...steps.entries()],
    async ([ordinal, step]): Promise<void> => {
      const index = step.index ?? ordinal;
      indices.add(index);
      await saveEntity(
        at.db,
        entity({
          id: `subagent:${run.id}:${index}`,
          kind: "session",
          title: step.task ?? run.task ?? step.agent ?? "Subagent",
          actor: step.agent ?? null,
          model: step.model ?? null,
          window: step.contextLimit ?? null,
          state: step.status ?? run.state,
          sourceAt,
          startedAt: timestamp(run.startedAt),
          endedAt: timestamp(run.endedAt),
          activityAt: timestamp(step.lastActivityAt),
          reason: run.error ?? null,
        }),
      );
    },
  );
  try {
    let unassigned = false;
    const pending = await ingestStream(at.db, join(folder, "events.jsonl"), {
      root: at.config.subagentRuns,
      session: (value: unknown): string | null => {
        const parsedStep = stepEvent.safeParse(value);
        if (
          !parsedStep.success ||
          parsedStep.data.subagentRunId !== run.id ||
          !indices.has(parsedStep.data.subagentStepIndex)
        ) {
          if (projectRecord(value, "", "", 0) !== null) {
            unassigned = true;
          }
          return null;
        }
        return `subagent:${run.id}:${parsedStep.data.subagentStepIndex}`;
      },
    });
    if (pending) {
      at.warnings.push(`Subagent transcript catching up: ${run.id}`);
    }
    if (unassigned) {
      at.warnings.push(`Unlinked subagent events excluded: ${run.id}`);
    }
  } catch {
    at.warnings.push(`Subagent transcript unavailable: ${run.id}`);
  }
}
async function collectGeneric(at: Collector): Promise<void> {
  const dirs = await newestDirs(at.config.subagentRuns, runLimit);
  if (dirs === null) {
    at.warnings.push("Subagent run directory unavailable");
    return;
  }
  if (dirs.omitted > 0) {
    at.warnings.push("Older subagent runs exceed the 200-run collection bound");
  }
  await collect(
    dirs.entries,
    (directory): Promise<void> => importGeneric(at, directory.name),
  );
}
type IssueReader = (repo: string, state: string) => Promise<unknown>;
async function githubIssues(repo: string, state: string): Promise<unknown> {
  const { stdout } = await execute(
    "gh",
    [
      "issue",
      "list",
      "-R",
      repo,
      "--state",
      state,
      "--limit",
      String(issueLimit),
      "--json",
      "number,title,state,updatedAt,closedAt,labels",
    ],
    { timeout: githubTimeout, maxBuffer: githubBuffer },
  );
  return parse(stdout);
}
async function issueList(
  at: Pick<Collector, "db" | "warnings">,
  repo: string,
  state: string,
  read: IssueReader,
): Promise<void> {
  const { db, warnings } = at;
  try {
    const items = z.array(itemSchema).parse(await read(repo, state));
    if (items.length === issueLimit) {
      warnings.push(`Issue list is partial: ${repo} (${state})`);
    }
    await collect(items, async (issue): Promise<void> => {
      const signals = issue.labels
        .map((label): string => label.name)
        .filter((name): boolean => workflowLabel.test(name));
      let reason: string | null = null;
      if (signals.length > 0) {
        reason = signals.join(" · ");
      }
      await saveEntity(
        db,
        entity({
          id: `${repo}#${issue.number}`,
          kind: "work",
          repo,
          issue: issue.number,
          title: issue.title,
          state: issue.state.toLowerCase(),
          sourceAt: issue.updatedAt,
          endedAt: issue.closedAt,
          reason,
        }),
      );
    });
    let healthState = "ok";
    let reason: string | null = null;
    if (items.length === issueLimit) {
      healthState = "partial";
      reason = "The issue list reached its collection bound";
    }
    await saveEntity(
      db,
      entity({
        id: `github:${repo}:${state}`,
        kind: "health",
        repo,
        title: `${repo} · ${state} issues`,
        state: healthState,
        sourceAt: new Date().toISOString(),
        reason,
      }),
    );
  } catch {
    const reason = `GitHub issue synchronization failed: ${repo} (${state}); previous values retained`;
    warnings.push(reason);
    await saveEntity(
      db,
      entity({
        id: `github:${repo}:${state}`,
        kind: "health",
        repo,
        title: `${repo} · ${state} issues`,
        state: "failed",
        sourceAt: new Date().toISOString(),
        reason,
      }),
    );
  }
}
async function collectIssues(
  db: Database,
  config: Config,
  warnings: string[],
  read: IssueReader = githubIssues,
): Promise<void> {
  await collect(
    config.repos.flatMap((repo) =>
      ["open", "closed"].map((state) => ({ repo, state })),
    ),
    ({ repo, state }): Promise<void> =>
      issueList({ db, warnings }, repo, state, read),
  );
}
/**
 * Imports the task runs under `runs`, their sessions' transcripts, generic
 * subagent runs and, when `github` is set, the configured repositories'
 * issues.
 */
async function collectMonitoring(
  db: Database,
  config: Config,
  runs: string,
  github: boolean,
): Promise<CollectionResult> {
  const at: Collector = { db, config, runs, warnings: [] };
  await collectTaskRuns(at);
  await collectGeneric(at);
  if (github) {
    await collectIssues(db, config, at.warnings);
  }
  const sourceAt = new Date().toISOString();
  let state = "ok";
  if (at.warnings.length > 0) {
    state = "partial";
  }
  await saveEntity(
    db,
    entity({
      id: "collector",
      kind: "health",
      title: "Monitoring",
      state,
      sourceAt,
      activityAt: sourceAt,
      reason: safeBody([...new Set(at.warnings)].join("\n")) || null,
    }),
  );
  return { warnings: at.warnings };
}

export type { CollectionResult };
export { collectIssues, collectMonitoring, ingestStream };
