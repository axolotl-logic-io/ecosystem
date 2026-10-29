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
import type { ActionRunObservation } from "../runtime-run-schema.ts";
import {
  type ActionRunEntry,
  type BuddyRunEntry,
  loadRuntimeRuns,
} from "../runtime-runs.ts";
import { parse } from "../source-records.ts";
import { entity, projectRecord, safeBody, timestamp } from "./records.ts";

const execute = promisify(execFile);
const chunkBytes = 2_097_152;
const statusBytes = 1_048_576;
const maxEvents = 2000;
const runLimit = 200;
const issueLimit = 1000;
const githubTimeout = 30_000;
const githubBuffer = 4_194_304;
const lf = 10;
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
async function importBuddy(at: Collector, entry: BuddyRunEntry): Promise<void> {
  const { run } = entry;
  const sourceAt = await sourceTime(entry.path);
  await saveEntity(
    at.db,
    entity({
      id: run.id,
      kind: "buddy",
      title: run.buddy.name,
      actor: run.buddy.name,
      state: entry.condition.state,
      startedAt: run.process.startedAt,
      activityAt: run.process.observedAt,
      sourceAt,
      reason: run.outcome?.reason ?? null,
    }),
  );
  await collect(run.loops, async (loop): Promise<void> => {
    await saveEntity(
      at.db,
      entity({
        id: `${run.id}:${loop.repo}:${loop.task}`,
        kind: "health",
        parent: run.id,
        repo: loop.repo,
        title: `${run.buddy.name} · ${loop.task}`,
        task: loop.task,
        state: loop.state,
        reason: loop.reason,
        sourceAt: run.process.observedAt,
      }),
    );
  });
}
async function importSession(
  at: Collector,
  entry: ActionRunEntry,
  session: ActionRunObservation["sessions"][number],
  sourceAt: string,
): Promise<void> {
  const { run } = entry;
  if (session.parent !== run.id) {
    at.warnings.push(
      "A session has an inconsistent parent; it was not imported",
    );
    return;
  }
  const link = entry.sessions.find(
    (candidate): boolean => candidate.id === session.id,
  );
  let activityAt: string | null = null;
  if (
    link?.file !== null &&
    link?.file !== undefined &&
    link.fileState === "present"
  ) {
    activityAt = await sourceTime(link.file);
  }
  await saveEntity(
    at.db,
    entity({
      id: session.id,
      kind: "session",
      parent: run.id,
      repo: run.workItem.repo,
      issue: run.workItem.number,
      title: session.agent,
      actor: session.agent,
      task: run.task,
      phase: session.phase,
      model: session.model,
      state: session.outcome ?? run.state,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      activityAt,
      sourceAt,
    }),
  );
  if (
    link?.file === null ||
    link?.file === undefined ||
    link.fileState !== "present"
  ) {
    at.warnings.push(`Transcript unavailable for session ${session.id}`);
    return;
  }
  try {
    if (
      await ingestStream(at.db, link.file, {
        root: at.config.runs,
        session: (): string => session.id,
      })
    ) {
      at.warnings.push(`Transcript catching up for session ${session.id}`);
    }
  } catch {
    at.warnings.push(
      `Transcript ingestion failed for session ${session.id}; inspect its append-only source`,
    );
  }
}
async function importAction(
  at: Collector,
  entry: ActionRunEntry,
  buddies: BuddyRunEntry[],
): Promise<void> {
  const { run } = entry;
  const active = run.sessions.find(
    (session): boolean => session.endedAt === null,
  );
  const operation = run.operations.find((op): boolean => op.endedAt === null);
  let state: string = run.outcome ?? run.state;
  let { reason } = run;
  if (
    run.checkpoint.state === "uncertain" ||
    run.ownership.state === "retained"
  ) {
    state = "blocked";
    reason =
      run.checkpoint.reason ??
      run.ownership.reason ??
      "Read-only reconciliation required";
  }
  const buddy = buddies.find(
    (candidate): boolean => candidate.run.id === run.buddyRun,
  );
  if (
    (state === "running" || state === "waiting") &&
    buddy?.condition.state !== "process-observed"
  ) {
    state = "status unavailable";
  }
  const starts = [...run.sessions, ...run.operations]
    .map((session): string => session.startedAt)
    .sort((a, b): number => a.localeCompare(b));
  const ends = [...run.sessions, ...run.operations]
    .flatMap((session): string[] => {
      if (session.endedAt !== null) {
        return [session.endedAt];
      }
      return [];
    })
    .sort((a, b): number => a.localeCompare(b));
  const sourceAt = await sourceTime(entry.path);
  await saveEntity(
    at.db,
    entity({
      id: run.id,
      kind: "action",
      repo: run.workItem.repo,
      issue: run.workItem.number,
      parent: run.buddyRun,
      title: `#${run.workItem.number}`,
      state,
      task: run.task,
      phase: active?.phase ?? operation?.op ?? null,
      actor: buddy?.run.buddy.name ?? null,
      sourceAt,
      startedAt: starts.at(0) ?? null,
      endedAt: ends.at(-1) ?? null,
      reason,
    }),
  );
  await collect(
    run.sessions,
    (session): Promise<void> => importSession(at, entry, session, sourceAt),
  );
}
async function collectPipeline(at: Collector): Promise<void> {
  const runs = await loadRuntimeRuns(at.config);
  if (
    runs.coverage.buddyRunsOmitted + runs.coverage.actionRunsOmitted > 0 ||
    runs.coverage.unlistable.length > 0 ||
    runs.problems.length > 0
  ) {
    at.warnings.push(
      "Some pipeline records are unavailable or outside collection bounds",
    );
  }
  await collect(
    runs.buddyRuns,
    (entry): Promise<void> => importBuddy(at, entry),
  );
  await collect(
    runs.actionRuns,
    (entry): Promise<void> => importAction(at, entry, runs.buddyRuns),
  );
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
      const start = issue.labels.find((label): boolean =>
        label.name.startsWith("start:"),
      );
      let reason: string | null = null;
      if (start !== undefined) {
        reason = `${start.name} requested; runtime qualification determines eligibility`;
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
async function collectMonitoring(
  db: Database,
  config: Config,
  github: boolean,
): Promise<CollectionResult> {
  const at: Collector = { db, config, warnings: [] };
  await collectPipeline(at);
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
