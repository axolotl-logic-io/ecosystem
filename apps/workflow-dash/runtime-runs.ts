// Reads the buddy runtime's local observations under the pipeline's runs
// folder: buddy runs at `buddy-runs/ID/run.json`, action runs at
// `SLUG/issue-N/actions/ID/run.json` and task app runs at
// `SLUG/issue-N/task-runs/ID/run.json`. They are observations, never
// authority. Runs link only through their explicit `previous`, `buddyRun`,
// loop `action` and session `parent` fields; nothing here infers a link
// from names, times, PIDs or a shared issue. A file that is missing,
// malformed, of another kind or version, or placed under the wrong path is
// reported as a problem and never becomes a run.
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { collect } from "./collection.ts";
import type { Config } from "./config.ts";
import {
  type DatedDirectory,
  dirs,
  fileState,
  newestDirs,
  readWhole,
} from "./local-files.ts";
import {
  inspectProcess,
  type ProcessInspection,
} from "./process-observations.ts";
import {
  type ActionRunObservation,
  actionRunSchema,
  type BuddyRunObservation,
  buddyRunSchema,
  type TaskRunObservation,
  taskRunSchema,
} from "./runtime-run-schema.ts";
import { parse } from "./source-records.ts";

const observationFile = "run.json";
const buddyRunFolder = "buddy-runs";
const observationReadBytes = 1_048_576;
const buddyRunReadLimit = 200;
const actionRunReadLimit = 500;
const millisecondsPerSecond = 1000;
const processStartSlack = 120_000;
const issueDirectory = /^issue-(?<issue>\d+)$/u;
const repositoryName = /^[\w][\w.-]*\/[\w][\w.-]*$/u;
const nodeExecutable = /^node(?:\d+(?:\.\d+)*)?$/u;
const buddyEntrypoint = /^buddy\.(?:mjs|ts)$/u;
const argumentSeparator = /\s+/u;
const sessionKey = /^[\w.-]+$/u;
const headerSchema = z.looseObject({
  kind: z.unknown(),
  version: z.unknown(),
});

type ObservationKind = "buddy-run" | "action-run" | "task-run";
interface Condition<State extends string> {
  state: State;
  reason: string;
}
type BuddyRunCondition = Condition<
  "process-observed" | "stale" | "unknown" | "stopped" | "ended"
>;
type ActionRunCondition = Condition<"unconfirmed" | "stopped" | "ended">;
type TaskRunCondition = Condition<
  "process-observed" | "stale" | "unknown" | "ended"
>;
interface BuddyRunEntry {
  path: string;
  run: BuddyRunObservation;
  condition: BuddyRunCondition;
  /** Observed action runs whose explicit `buddyRun` names this run. */
  actions: string[];
  previousObserved: boolean;
  warnings: string[];
}
/** An action run's explicit `buddyRun` and that buddy run's condition. */
interface BuddyRunLink {
  id: string;
  condition: BuddyRunCondition["state"] | "not observed";
  reason: string;
}
interface SessionLink {
  id: string;
  key: string;
  /** The session's JSONL in its action run's folder. */
  file: string | null;
  fileState: "present" | "missing" | "unreadable" | "unsafe key";
  parentMatches: boolean;
}
interface ActionRunEntry {
  path: string;
  run: ActionRunObservation;
  condition: ActionRunCondition;
  buddyRun: BuddyRunLink;
  previousObserved: boolean;
  sessions: SessionLink[];
  warnings: string[];
}
interface TaskRunEntry {
  path: string;
  run: TaskRunObservation;
  condition: TaskRunCondition;
}
interface ObservationProblem {
  kind: ObservationKind;
  path: string;
  reason: string;
}
interface RuntimeRunCoverage {
  root: string;
  repositories: string[];
  buddyRunsOmitted: number;
  actionRunsOmitted: number;
  taskRunsOmitted: number;
  unlistable: string[];
  note: string;
}
interface RuntimeRuns {
  buddyRuns: BuddyRunEntry[];
  actionRuns: ActionRunEntry[];
  taskRuns: TaskRunEntry[];
  problems: ObservationProblem[];
  coverage: RuntimeRunCoverage;
}
interface RuntimeRunSources {
  now: () => number;
  host: string;
  inspect: (pid: number) => Promise<ProcessInspection>;
}
type Read<T> =
  | { ok: true; path: string; run: T }
  | { ok: false; path: string; reason: string };
interface ActionLocation extends DatedDirectory {
  repo: string;
  issue: number;
  folder: string;
}

const coverageNote =
  "Bounded local observations, newest first. They are never authority; omitted, unreadable or malformed files leave coverage partial.";
const defaultSources: RuntimeRunSources = {
  now: Date.now,
  host: hostname(),
  inspect: inspectProcess,
};
const emptyRuntimeRuns: RuntimeRuns = {
  buddyRuns: [],
  actionRuns: [],
  taskRuns: [],
  problems: [],
  coverage: {
    root: "",
    repositories: [],
    buddyRunsOmitted: 0,
    actionRunsOmitted: 0,
    taskRunsOmitted: 0,
    unlistable: [],
    note: "Not collected yet.",
  },
};

function shapeProblem(
  value: unknown,
  kind: ObservationKind,
  issue: z.core.$ZodIssue | undefined,
): string {
  const header = headerSchema.safeParse(value);
  if (!header.success) {
    return "not a JSON object";
  }
  if (header.data.kind !== kind) {
    return `not a ${kind} observation`;
  }
  if (header.data.version !== 1) {
    return `unsupported version ${String(header.data.version)}`;
  }
  const where = issue?.path.map(String).join(".") || "(root)";
  return `does not match the ${kind} v1 schema at ${where}: ${issue?.message ?? "invalid"}`;
}

async function readObservation<T>(
  path: string,
  kind: ObservationKind,
  schema: z.ZodType<T>,
): Promise<Read<T>> {
  const file = await readWhole(path, observationReadBytes);
  if (file.state === "unavailable") {
    return { ok: false, path, reason: file.reason };
  }
  const value = parse(file.text);
  if (value === null) {
    return { ok: false, path, reason: "invalid JSON" };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { ok: true, path, run: parsed.data };
  }
  return {
    ok: false,
    path,
    reason: shapeProblem(value, kind, parsed.error.issues.at(0)),
  };
}

function problems<T>(
  kind: ObservationKind,
  reads: Read<T>[],
): ObservationProblem[] {
  return reads.flatMap((read) => {
    if (read.ok) {
      return [];
    }
    return [{ kind, path: read.path, reason: read.reason }];
  });
}

function observed<T>(reads: Read<T>[]): { path: string; run: T }[] {
  return reads.flatMap((read) => {
    if (read.ok) {
      return [{ path: read.path, run: read.run }];
    }
    return [];
  });
}

/** The last segment of an executable or script path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Whether `command` runs a buddy entrypoint as Node's main script: a Node
 * executable, its options, then `buddy.mjs` or `buddy.ts`. A shell, search
 * or other script that only mentions the name doesn't match. Paths with
 * spaces can't be split reliably and don't match.
 */
function runsBuddyEntrypoint(command: string): boolean {
  const [executable, ...args] = command.split(argumentSeparator);
  if (executable === undefined || !nodeExecutable.test(baseName(executable))) {
    return false;
  }
  const script = args.find((arg) => !arg.startsWith("-"));
  return script !== undefined && buddyEntrypoint.test(baseName(script));
}

/**
 * Whether the observed process could be the one that recorded `run`: it
 * started at most `processStartSlack` before the run, and no later than the
 * second the run started. ps reports start times to the second.
 */
function sameIncarnation(
  run: BuddyRunObservation,
  processStartedAt: number,
): boolean {
  const runStartedAt = Date.parse(run.process.startedAt);
  return (
    processStartedAt <= runStartedAt + millisecondsPerSecond &&
    runStartedAt - processStartedAt <= processStartSlack
  );
}

/** Lease and process-observation freshness; null when both are fresh. */
function freshness(
  run: BuddyRunObservation,
  now: number,
): BuddyRunCondition | null {
  const observedAt = Date.parse(run.process.observedAt);
  const window = run.lease.seconds * millisecondsPerSecond;
  if (Date.parse(run.lease.expiresAt) <= now) {
    return {
      state: "stale",
      reason: `recorded ${run.state}, but its lease expired at ${run.lease.expiresAt}`,
    };
  }
  if (now - observedAt > window) {
    return {
      state: "stale",
      reason: `recorded ${run.state}, but its process observation at ${run.process.observedAt} is older than its ${run.lease.seconds}s lease`,
    };
  }
  if (observedAt - now > window) {
    return {
      state: "unknown",
      reason: `its process observation at ${run.process.observedAt} is later than this host's clock allows`,
    };
  }
  return null;
}

function processCondition(
  run: BuddyRunObservation,
  inspection: ProcessInspection,
): BuddyRunCondition {
  const { pid } = run.process;
  if (inspection.state === "absent") {
    return {
      state: "stale",
      reason: `recorded ${run.state}, but process ${pid} is not running`,
    };
  }
  if (inspection.state === "unknown") {
    return { state: "unknown", reason: `process ${pid}: ${inspection.reason}` };
  }
  if (!runsBuddyEntrypoint(inspection.command)) {
    return {
      state: "stale",
      reason: `recorded ${run.state}, but process ${pid} doesn't run the buddy entrypoint`,
    };
  }
  if (inspection.startedAt === null) {
    return {
      state: "process-observed",
      reason: `process ${pid} runs the buddy entrypoint, but its start time is unreadable, so it may not be this run's process. Lease until ${run.lease.expiresAt}.`,
    };
  }
  if (!sameIncarnation(run, inspection.startedAt)) {
    return {
      state: "stale",
      reason: `recorded ${run.state}, but process ${pid} started at ${new Date(inspection.startedAt).toISOString()}, not with this run; the pid may be reused`,
    };
  }
  return {
    state: "process-observed",
    reason: `process ${pid} runs the buddy entrypoint and started with this run. Lease until ${run.lease.expiresAt}. A matching process isn't proof of the run's identity.`,
  };
}

/**
 * A recorded running or waiting buddy run counts as process-observed only
 * when its lease is unexpired, its process observation is fresh, it was
 * recorded on this host, and its pid runs the buddy entrypoint. None of it
 * is authority.
 */
async function buddyRunCondition(
  run: BuddyRunObservation,
  sources: RuntimeRunSources,
): Promise<BuddyRunCondition> {
  if (run.state === "stopped" || run.state === "ended") {
    return {
      state: run.state,
      reason: `recorded ${run.state}: ${run.outcome?.reason ?? "no outcome recorded"}`,
    };
  }
  const stale = freshness(run, sources.now());
  if (stale !== null) {
    return stale;
  }
  if (run.process.host !== sources.host) {
    return {
      state: "unknown",
      reason: `recorded on host ${run.process.host}; this host can't inspect its process`,
    };
  }
  return processCondition(run, await sources.inspect(run.process.pid));
}

/**
 * An action run's own recorded state. Its buddy run's condition is reported
 * separately and never makes the action live.
 */
function actionRunCondition(run: ActionRunObservation): ActionRunCondition {
  if (run.state === "stopped" || run.state === "ended") {
    return {
      state: run.state,
      reason: `recorded ${run.state}; outcome ${run.outcome ?? "not recorded"}`,
    };
  }
  return {
    state: "unconfirmed",
    reason: `recorded ${run.state}. An action run has no process observation of its own; its buddy run's condition is separate.`,
  };
}

function buddyRunLink(
  run: ActionRunObservation,
  buddy: BuddyRunEntry | undefined,
): BuddyRunLink {
  if (buddy === undefined) {
    return {
      id: run.buddyRun,
      condition: "not observed",
      reason: "no readable buddy-run observation has this id",
    };
  }
  return {
    id: run.buddyRun,
    condition: buddy.condition.state,
    reason: buddy.condition.reason,
  };
}

function sessionLinks(
  path: string,
  run: ActionRunObservation,
): Promise<SessionLink[]> {
  const folder = join(path, "..", "sessions");
  return collect(run.sessions, async (session): Promise<SessionLink> => {
    const link = {
      id: session.id,
      key: session.key,
      parentMatches: session.parent === run.id,
    };
    if (!sessionKey.test(session.key) || session.key.startsWith(".")) {
      return { ...link, file: null, fileState: "unsafe key" };
    }
    const file = join(folder, `${session.key}.jsonl`);
    return { ...link, file, fileState: await fileState(file) };
  });
}

function actionWarnings(
  run: ActionRunObservation,
  sessions: SessionLink[],
): string[] {
  const warnings: string[] = [];
  if (run.outcome === "unknown") {
    warnings.push(
      "Outcome unknown: reconcile by reading its effects; never repeat it to get a clearer result.",
    );
  }
  if (run.checkpoint.state === "uncertain") {
    warnings.push(
      `Checkpoint uncertain: ${run.checkpoint.reason ?? "no reason recorded"}`,
    );
  }
  if (run.ownership.state === "retained") {
    warnings.push(
      `Issue execution retained: ${run.ownership.reason ?? "no reason recorded"}`,
    );
  }
  for (const reservation of run.reservations) {
    if (reservation.state === "held") {
      warnings.push(
        `${reservation.resource} slot ${reservation.slot} recorded held; an observation never releases it.`,
      );
    }
  }
  if (run.execution.instance !== run.id) {
    warnings.push(
      `Execution instance ${run.execution.instance} differs from the action run's id.`,
    );
  }
  for (const session of run.sessions) {
    if (session.parent !== run.id) {
      warnings.push(
        `Session ${session.id} names parent ${session.parent}, not this action run.`,
      );
    }
  }
  for (const session of sessions) {
    if (session.fileState !== "present") {
      warnings.push(`Session ${session.id} file: ${session.fileState}.`);
    }
  }
  return warnings;
}

async function readBuddyRuns(root: string): Promise<{
  reads: Read<BuddyRunObservation>[];
  omitted: number;
  listed: boolean;
}> {
  const folder = join(root, buddyRunFolder);
  const listing = await newestDirs(folder, buddyRunReadLimit);
  if (listing === null) {
    return { reads: [], omitted: 0, listed: false };
  }
  const reads = await collect(
    listing.entries,
    async ({ name }): Promise<Read<BuddyRunObservation>> => {
      const read = await readObservation(
        join(folder, name, observationFile),
        "buddy-run",
        buddyRunSchema,
      );
      if (read.ok && read.run.id !== name) {
        return {
          ok: false,
          path: read.path,
          reason: `records id ${read.run.id} under folder ${name}`,
        };
      }
      return read;
    },
  );
  return { reads, omitted: listing.omitted, listed: true };
}

/** The run folders under each of `repo`'s issue folders' `folder`. */
async function runLocations(
  root: string,
  repo: string,
  runs: "actions" | "task-runs",
): Promise<{ locations: ActionLocation[]; omitted: number }> {
  const repoRoot = join(root, repo.replace("/", "__"));
  const issues = (await dirs(repoRoot)).flatMap((name) => {
    const issue = issueDirectory.exec(name)?.groups?.issue;
    if (issue === undefined) {
      return [];
    }
    return [{ name, issue: Number(issue) }];
  });
  const listings = await collect(issues, async ({ name, issue }) => {
    const folder = join(repoRoot, name, runs);
    const listing = await newestDirs(folder, actionRunReadLimit);
    return {
      omitted: listing?.omitted ?? 0,
      locations: (listing?.entries ?? []).map(
        (entry): ActionLocation => ({ ...entry, repo, issue, folder }),
      ),
    };
  });
  return {
    locations: listings.flatMap((listing) => listing.locations),
    omitted: listings.reduce((sum, listing) => sum + listing.omitted, 0),
  };
}

async function readActionRun(
  location: ActionLocation,
): Promise<Read<ActionRunObservation>> {
  const read = await readObservation(
    join(location.folder, location.name, observationFile),
    "action-run",
    actionRunSchema,
  );
  if (!read.ok) {
    return read;
  }
  const { run } = read;
  if (
    run.id !== location.name ||
    run.workItem.repo !== location.repo ||
    run.workItem.number !== location.issue
  ) {
    return {
      ok: false,
      path: read.path,
      reason: `records ${run.workItem.repo}#${run.workItem.number} action ${run.id} under ${location.repo}#${location.issue}/${location.name}`,
    };
  }
  return read;
}

async function readActionRuns(
  root: string,
  repositories: string[],
): Promise<{ reads: Read<ActionRunObservation>[]; omitted: number }> {
  const found = await collect(repositories, (repo) =>
    runLocations(root, repo, "actions"),
  );
  const locations = found
    .flatMap((item) => item.locations)
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  const reads = await collect(
    locations.slice(0, actionRunReadLimit),
    readActionRun,
  );
  return {
    reads,
    omitted:
      found.reduce((sum, item) => sum + item.omitted, 0) +
      Math.max(0, locations.length - actionRunReadLimit),
  };
}

async function readTaskRun(
  location: ActionLocation,
): Promise<Read<TaskRunObservation>> {
  const read = await readObservation(
    join(location.folder, location.name, observationFile),
    "task-run",
    taskRunSchema,
  );
  if (!read.ok) {
    return read;
  }
  const { run } = read;
  if (
    run.id !== location.name ||
    run.workItem.repo !== location.repo ||
    run.workItem.number !== location.issue
  ) {
    return {
      ok: false,
      path: read.path,
      reason: `records ${run.workItem.repo}#${run.workItem.number} task run ${run.id} under ${location.repo}#${location.issue}/${location.name}`,
    };
  }
  return read;
}

async function readTaskRuns(
  root: string,
  repositories: string[],
): Promise<{ reads: Read<TaskRunObservation>[]; omitted: number }> {
  const found = await collect(repositories, (repo) =>
    runLocations(root, repo, "task-runs"),
  );
  const locations = found
    .flatMap((item) => item.locations)
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  const reads = await collect(
    locations.slice(0, actionRunReadLimit),
    readTaskRun,
  );
  return {
    reads,
    omitted:
      found.reduce((sum, item) => sum + item.omitted, 0) +
      Math.max(0, locations.length - actionRunReadLimit),
  };
}

/**
 * A task run recorded running counts as process-observed only when it was
 * recorded on this host and its pid runs, started with the run. A run whose
 * process is gone crashed: it never ends its record.
 */
async function taskRunCondition(
  run: TaskRunObservation,
  sources: RuntimeRunSources,
): Promise<TaskRunCondition> {
  if (run.state === "ended") {
    return {
      state: "ended",
      reason: `recorded ended; outcome ${run.outcome ?? "not recorded"}`,
    };
  }
  const { pid, host } = run.process;
  if (host !== sources.host) {
    return {
      state: "unknown",
      reason: `recorded on host ${host}; this host can't inspect its process`,
    };
  }
  const inspection = await sources.inspect(pid);
  if (inspection.state === "absent") {
    return {
      state: "stale",
      reason: `recorded running, but process ${pid} is not running`,
    };
  }
  if (inspection.state === "unknown") {
    return { state: "unknown", reason: `process ${pid}: ${inspection.reason}` };
  }
  if (
    inspection.startedAt !== null &&
    Math.abs(inspection.startedAt - Date.parse(run.startedAt)) >
      processStartSlack
  ) {
    return {
      state: "stale",
      reason: `recorded running, but process ${pid} didn't start with this run; the pid may be reused`,
    };
  }
  return {
    state: "process-observed",
    reason: `process ${pid} is running. A matching process isn't proof of the run's identity.`,
  };
}

function loopWarnings(
  run: BuddyRunObservation,
  actionIds: ReadonlySet<string>,
): string[] {
  return run.loops.flatMap((loop) => {
    if (loop.action === null || actionIds.has(loop.action)) {
      return [];
    }
    return [
      `Loop ${loop.task} on ${loop.repo} names action run ${loop.action}, which is not observed.`,
    ];
  });
}

function scopedRepositories(
  config: Config,
  runs: { run: BuddyRunObservation }[],
): string[] {
  const named = runs.flatMap(({ run }) =>
    run.scope.repositories.map((repository) => repository.repo),
  );
  return [...new Set([...config.repos, ...named])]
    .filter((repo) => repositoryName.test(repo))
    .sort((a, b) => a.localeCompare(b));
}

/** Every bounded buddy-run, action-run and task-run observation under `config.runs`. */
async function loadRuntimeRuns(
  config: Config,
  sources: RuntimeRunSources = defaultSources,
): Promise<RuntimeRuns> {
  const buddy = await readBuddyRuns(config.runs);
  const buddyObservations = observed(buddy.reads);
  const repositories = scopedRepositories(config, buddyObservations);
  const actions = await readActionRuns(config.runs, repositories);
  const actionObservations = observed(actions.reads);
  const tasks = await readTaskRuns(config.runs, repositories);
  const taskRuns = await collect(
    observed(tasks.reads),
    async ({ path, run }): Promise<TaskRunEntry> => ({
      path,
      run,
      condition: await taskRunCondition(run, sources),
    }),
  );
  taskRuns.sort(
    (a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt),
  );
  const actionIds = new Set(actionObservations.map(({ run }) => run.id));
  const buddyIds = new Set(buddyObservations.map(({ run }) => run.id));
  const buddyRuns = await collect(
    buddyObservations,
    async ({ path, run }): Promise<BuddyRunEntry> => ({
      path,
      run,
      condition: await buddyRunCondition(run, sources),
      actions: actionObservations
        .filter((action) => action.run.buddyRun === run.id)
        .map((action) => action.run.id),
      previousObserved: run.previous !== null && buddyIds.has(run.previous),
      warnings: loopWarnings(run, actionIds),
    }),
  );
  buddyRuns.sort(
    (a, b) =>
      Date.parse(b.run.process.startedAt) - Date.parse(a.run.process.startedAt),
  );
  const byId = new Map(buddyRuns.map((entry) => [entry.run.id, entry]));
  const actionRuns = await collect(
    actionObservations,
    async ({ path, run }): Promise<ActionRunEntry> => {
      const sessions = await sessionLinks(path, run);
      return {
        path,
        run,
        condition: actionRunCondition(run),
        buddyRun: buddyRunLink(run, byId.get(run.buddyRun)),
        previousObserved: run.previous !== null && actionIds.has(run.previous),
        sessions,
        warnings: actionWarnings(run, sessions),
      };
    },
  );
  const unlistable: string[] = [];
  if (!buddy.listed) {
    unlistable.push(join(config.runs, buddyRunFolder));
  }
  return {
    buddyRuns,
    actionRuns,
    taskRuns,
    problems: [
      ...problems("buddy-run", buddy.reads),
      ...problems("action-run", actions.reads),
      ...problems("task-run", tasks.reads),
    ],
    coverage: {
      root: config.runs,
      repositories,
      buddyRunsOmitted: buddy.omitted,
      actionRunsOmitted: actions.omitted,
      taskRunsOmitted: tasks.omitted,
      unlistable,
      note: coverageNote,
    },
  };
}

export type {
  ActionRunCondition,
  ActionRunEntry,
  BuddyRunCondition,
  BuddyRunEntry,
  BuddyRunLink,
  ObservationProblem,
  RuntimeRunCoverage,
  RuntimeRunSources,
  RuntimeRuns,
  SessionLink,
  TaskRunCondition,
  TaskRunEntry,
};
export { emptyRuntimeRuns, loadRuntimeRuns };
