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
const observationNote =
  "Local observations only, never authority. A process-observed buddy run had a matching live process on this host; that isn't proof of the run's identity. Stale, unknown, unconfirmed and unreadable entries are uncertain.";
function result(value: unknown): ReadResult {
  let text = JSON.stringify(value, null, 2);
  if (text.length > maximumOutputCharacters) {
    text = `${text.slice(0, truncatedOutputCharacters)}\n[Truncated at 12KB; use action_run or open /dash for local details.]`;
  }
  return { content: [{ type: "text", text }], details: undefined };
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
function runtimeSummary(runtime: RuntimeRuns): ReadResult {
  return result({
    note: observationNote,
    coverage: runtime.coverage,
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
export { actionRunDetail, runtimeSummary };
