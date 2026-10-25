import type { Snapshot } from "./data.ts";
import { jobProcessObservation, legacyJobProcesses } from "./job-conditions.ts";
import type { HistoricalJob, JobDetails } from "./job-history.ts";
import { capacity } from "./legacy-capacity.ts";
import type {
  ActionRunEntry,
  BuddyRunEntry,
  RuntimeRuns,
} from "./runtime-runs.ts";

interface ReadResult {
  content: { type: "text"; text: string }[];
  details: undefined;
}
const maximumOutputCharacters = 12_000;
const truncatedOutputCharacters = 11_900;
const historicalNote =
  "Historical job records from the retired job runtime. They are not the current workflow, map to no task, and name no buddy run or action run; use buddy_runs for current observations.";
const observationNote =
  "Local observations only, never authority. A process-observed buddy run had a matching live process on this host; that isn't proof of the run's identity. Stale, unknown, unconfirmed and unreadable entries are uncertain.";
function result(value: unknown): ReadResult {
  let text = JSON.stringify(value, null, 2);
  if (text.length > maximumOutputCharacters) {
    text = `${text.slice(0, truncatedOutputCharacters)}\n[Truncated at 12KB; use action_run or open /dash for local details.]`;
  }
  return { content: [{ type: "text", text }], details: undefined };
}
function historicalEvidence(run: HistoricalJob): {
  id: string | null | undefined;
  sourceStage: string | null | undefined;
  jobProcessObservation: string;
} {
  return {
    id: run.data.id,
    sourceStage: run.data.stage,
    jobProcessObservation: jobProcessObservation(run),
  };
}
function summary(state: Snapshot, legacy: boolean): ReadResult {
  const common = {
    hold: state.hold,
    installed: state.installed,
    main: state.main,
  };
  if (legacy) {
    const values = capacity(state.jobHistory);
    return result({
      capacity: {
        jobs: values.activeRuns,
        limit: values.limit,
        author: values.authorImplementation,
        review: values.hardening,
        authorLimit: values.authorImplementationLimit,
        reviewLimit: values.hardeningLimit,
        pbWeb: values.pbWeb,
      },
      jobs: state.jobHistory
        .filter((run) => run.live === true)
        .map((run) => ({
          repo: run.repo,
          issue: run.issue,
          stage: run.data.stage,
          pid: run.data.pid,
          launch: run.data.launches.at(-1)?.key,
          startedAt: run.data.startedAt,
        })),
      ...common,
    });
  }
  return result({
    history: historicalNote,
    legacyJobProcesses: legacyJobProcesses(state.jobHistory),
    coverage:
      "Bounded local reads; unavailable or malformed files may be omitted.",
    runs: state.jobHistory
      .filter((run) => run.live !== false)
      .map((run) => ({
        ...historicalEvidence(run),
        repo: run.repo,
        issue: run.issue,
        pid: run.data.pid,
        launch: run.data.launches.at(-1)?.key,
        startedAt: run.data.startedAt,
      })),
    ...common,
  });
}
function detail(
  run: HistoricalJob,
  data: JobDetails,
  legacy: boolean,
): ReadResult {
  const launches = data.timeline.map((launch) => ({
    key: launch.key,
    kind: launch.kind,
    startedAt: launch.startedAt,
    seconds: launch.seconds,
    outcome: launch.outcome,
    turns: launch.turns,
    usage: launch.usage,
  }));
  const common = {
    repo: run.repo,
    issue: run.issue,
    outcome: run.data.outcome,
    stopReason: data.stopReason,
    verify: data.verify,
    launches,
  };
  if (legacy) {
    return result({ ...common, stage: run.data.stage });
  }
  return result({
    history: historicalNote,
    ...common,
    ...historicalEvidence(run),
  });
}

function buddyRunSummary(entry: BuddyRunEntry): Record<string, unknown> {
  const { run } = entry;
  return {
    id: run.id,
    condition: entry.condition,
    state: run.state,
    outcome: run.outcome,
    buddy: { name: run.buddy.name, role: run.buddy.role },
    tasks: run.tasks,
    previous: run.previous,
    previousObserved: entry.previousObserved,
    process: run.process,
    lease: run.lease,
    stop: run.stop,
    loops: run.loops.map((loop) => ({
      task: loop.task,
      repo: loop.repo,
      state: loop.state,
      action: loop.action,
    })),
    actionRuns: entry.actions,
    warnings: entry.warnings,
    path: entry.path,
  };
}
function actionRunSummary(entry: ActionRunEntry): Record<string, unknown> {
  const { run } = entry;
  return {
    id: run.id,
    condition: entry.condition,
    buddyRun: entry.buddyRun,
    task: run.task,
    workItem: run.workItem,
    state: run.state,
    outcome: run.outcome,
    sessions: run.sessions.map((session) => session.id),
    warnings: entry.warnings,
  };
}
function runtimeSummary(
  runtime: RuntimeRuns,
  configWarnings: string[],
): ReadResult {
  return result({
    note: observationNote,
    coverage: { ...runtime.coverage, configWarnings },
    problems: runtime.problems,
    buddyRuns: runtime.buddyRuns.map(buddyRunSummary),
    actionRuns: runtime.actionRuns.map(actionRunSummary),
  });
}
/** One action run's whole observation and its explicit links. */
function actionRunDetail(entry: ActionRunEntry): ReadResult {
  return result({
    note: observationNote,
    condition: entry.condition,
    links: {
      buddyRun: entry.buddyRun,
      previous: { id: entry.run.previous, observed: entry.previousObserved },
      sessions: entry.sessions,
    },
    warnings: entry.warnings,
    path: entry.path,
    observation: entry.run,
  });
}

export type { ReadResult };
export { actionRunDetail, detail, runtimeSummary, summary };
