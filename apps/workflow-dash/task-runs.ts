// Reads the task runs that task apps record under the runs folder, at
// `SLUG/issue-N/task-runs/ID/run.json`, with their model sessions'
// transcripts in `sessions/KEY.jsonl` beside each record. A run record is
// an observation, never authority. A file that is missing, malformed or
// placed under the wrong path is reported as a problem and never becomes a
// run.
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { collect } from "./collection.ts";
import { dirs, files, newestDirs, readWhole } from "./local-files.ts";
import {
  inspectProcess,
  type ProcessInspection,
} from "./process-observations.ts";
import { parse } from "./source-records.ts";

const recordFile = "run.json";
const recordReadBytes = 1_048_576;
const taskRunReadLimit = 500;
const processStartSlack = 120_000;
const issueDirectory = /^issue-(?<issue>\d+)$/u;
const transcriptFile = /^(?<key>[\w-][\w.-]*)\.jsonl$/u;
const taskIdPattern = /^[a-z][a-z0-9-]*$/u;
const repositoryPattern = /^[\w.-]+\/[\w.-]+$/u;
const time = z.iso.datetime();

// The task framework's TASK_RUN, exported by
// apps/issue-host/src/task-app/run-record.ts. Dash keeps this reader copy
// because the writer module reads the host's environment when imported. A
// test compares both copies' JSON Schemas through an issue-host subprocess.
const taskRunSchema = z.strictObject({
  kind: z.literal("task-run"),
  version: z.literal(1),
  id: z.uuid(),
  task: z.string().regex(taskIdPattern),
  workItem: z.strictObject({
    repo: z.string().regex(repositoryPattern),
    number: z.number().int().positive(),
  }),
  account: z.string().min(1),
  claim: z.strictObject({
    start: z.number().int().positive().nullable(),
    removal: z.number().int().positive(),
  }),
  process: z.strictObject({
    pid: z.int().positive(),
    host: z.string().min(1),
  }),
  state: z.enum(["running", "ended"]),
  step: z.enum(["mark", "work", "unmark"]),
  outcome: z.enum(["succeeded", "failed", "stopped"]).nullable(),
  reason: z.string().nullable(),
  startedAt: time,
  endedAt: time.nullable(),
});
type TaskRunRecord = z.infer<typeof taskRunSchema>;

/**
 * What the dashboard can say about a run: `running` only while its process
 * is observed on this host, `unavailable` when a run recorded as running
 * has no observed process, and its recorded outcome once it ended.
 */
type TaskRunState =
  | "running"
  | "unavailable"
  | NonNullable<TaskRunRecord["outcome"]>;
interface TaskRunSession {
  /** The session's key, its transcript's file name without `.jsonl`. */
  key: string;
  transcript: string;
}
interface TaskRun {
  path: string;
  record: TaskRunRecord;
  state: TaskRunState;
  /** Why the state is what it is, or the recorded reason of a failed run. */
  reason: string | null;
  sessions: TaskRunSession[];
}
interface TaskRunProblem {
  path: string;
  reason: string;
}
interface TaskRuns {
  runs: TaskRun[];
  problems: TaskRunProblem[];
  /** Task runs left unread beyond the collection bound. */
  omitted: number;
}
interface TaskRunSources {
  host: string;
  inspect: (pid: number) => Promise<ProcessInspection>;
}
interface RunLocation {
  repo: string;
  issue: number;
  folder: string;
  name: string;
  mtime: number;
}
type Read =
  | { ok: true; location: RunLocation; record: TaskRunRecord }
  | { ok: false; path: string; reason: string };

const defaultSources: TaskRunSources = {
  host: hostname(),
  inspect: inspectProcess,
};

function recordPath(location: RunLocation): string {
  return join(location.folder, location.name, recordFile);
}

async function locations(
  root: string,
  repo: string,
): Promise<{ found: RunLocation[]; omitted: number }> {
  const repoRoot = join(root, repo.replace("/", "__"));
  const issues = (await dirs(repoRoot)).flatMap((name) => {
    const issue = issueDirectory.exec(name)?.groups?.issue;
    if (issue === undefined) {
      return [];
    }
    return [{ name, issue: Number(issue) }];
  });
  const listings = await collect(issues, async ({ name, issue }) => {
    const folder = join(repoRoot, name, "task-runs");
    const listing = await newestDirs(folder, taskRunReadLimit);
    return {
      omitted: listing?.omitted ?? 0,
      found: (listing?.entries ?? []).map(
        (entry): RunLocation => ({ ...entry, repo, issue, folder }),
      ),
    };
  });
  return {
    found: listings.flatMap((listing) => listing.found),
    omitted: listings.reduce((sum, listing) => sum + listing.omitted, 0),
  };
}

async function readRecord(location: RunLocation): Promise<Read> {
  const path = recordPath(location);
  const file = await readWhole(path, recordReadBytes);
  if (file.state === "unavailable") {
    return { ok: false, path, reason: file.reason };
  }
  const parsed = taskRunSchema.safeParse(parse(file.text));
  if (!parsed.success) {
    const issue = parsed.error.issues.at(0);
    const where = issue?.path.map(String).join(".") || "(root)";
    return {
      ok: false,
      path,
      reason: `not a task run record at ${where}: ${issue?.message ?? "invalid"}`,
    };
  }
  const record = parsed.data;
  if (
    record.id !== location.name ||
    record.workItem.repo !== location.repo ||
    record.workItem.number !== location.issue
  ) {
    return {
      ok: false,
      path,
      reason: `records ${record.workItem.repo}#${record.workItem.number} task run ${record.id} under ${location.repo}#${location.issue}/${location.name}`,
    };
  }
  return { ok: true, location, record };
}

/**
 * A run recorded as running is running only when it was recorded on this
 * host and its pid runs a process that started with the run. A run whose
 * process is gone crashed: it never ends its record.
 */
async function observe(
  record: TaskRunRecord,
  sources: TaskRunSources,
): Promise<Pick<TaskRun, "state" | "reason">> {
  if (record.state === "ended") {
    if (record.outcome === null) {
      return {
        state: "unavailable",
        reason: "recorded ended without an outcome",
      };
    }
    return { state: record.outcome, reason: record.reason };
  }
  const { pid, host } = record.process;
  if (host !== sources.host) {
    return {
      state: "unavailable",
      reason: `recorded running on host ${host}; this host can't inspect its process`,
    };
  }
  const inspection = await sources.inspect(pid);
  if (inspection.state === "absent") {
    return {
      state: "unavailable",
      reason: `recorded running, but process ${pid} is not running`,
    };
  }
  if (inspection.state === "unknown") {
    return {
      state: "unavailable",
      reason: `process ${pid}: ${inspection.reason}`,
    };
  }
  if (
    inspection.startedAt !== null &&
    Math.abs(inspection.startedAt - Date.parse(record.startedAt)) >
      processStartSlack
  ) {
    return {
      state: "unavailable",
      reason: `recorded running, but process ${pid} didn't start with this run; the pid may be reused`,
    };
  }
  return { state: "running", reason: null };
}

async function sessions(location: RunLocation): Promise<TaskRunSession[]> {
  const folder = join(location.folder, location.name, "sessions");
  return (await files(folder)).flatMap((name) => {
    const key = transcriptFile.exec(name)?.groups?.key;
    if (key === undefined) {
      return [];
    }
    return [{ key, transcript: join(folder, name) }];
  });
}

/** The newest task runs of `repositories` under the runs folder `root`. */
async function loadTaskRuns(
  root: string,
  repositories: readonly string[],
  sources: TaskRunSources = defaultSources,
): Promise<TaskRuns> {
  const listed = await collect(repositories, (repo) => locations(root, repo));
  const found = listed
    .flatMap((item) => item.found)
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  const reads = await collect(found.slice(0, taskRunReadLimit), readRecord);
  const runs = await collect(
    reads.flatMap((read) => {
      if (read.ok) {
        return [read];
      }
      return [];
    }),
    async ({ location, record }): Promise<TaskRun> => ({
      path: recordPath(location),
      record,
      ...(await observe(record, sources)),
      sessions: await sessions(location),
    }),
  );
  runs.sort(
    (a, b) => Date.parse(b.record.startedAt) - Date.parse(a.record.startedAt),
  );
  return {
    runs,
    problems: reads.flatMap((read) => {
      if (read.ok) {
        return [];
      }
      return [{ path: read.path, reason: read.reason }];
    }),
    omitted:
      listed.reduce((sum, item) => sum + item.omitted, 0) +
      Math.max(0, found.length - taskRunReadLimit),
  };
}

export type {
  TaskRun,
  TaskRunProblem,
  TaskRunRecord,
  TaskRunSession,
  TaskRunSources,
  TaskRunState,
  TaskRuns,
};
export { loadTaskRuns, taskRunSchema };
