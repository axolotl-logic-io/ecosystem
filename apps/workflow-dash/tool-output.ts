import type { Snapshot } from "./data.ts";
import { executionLabel, stageLabel, taskCoverage } from "./language.ts";
import { capacity } from "./legacy-capacity.ts";
import { observedCapacity, processObservation } from "./observations.ts";
import type { RunDetails, WorkflowRun } from "./workflow-source.ts";

interface ReadResult {
  content: { type: "text"; text: string }[];
  details: undefined;
}
const maximumOutputCharacters = 12_000;
const truncatedOutputCharacters = 11_900;
function result(value: unknown): ReadResult {
  let text = JSON.stringify(value, null, 2);
  if (text.length > maximumOutputCharacters) {
    text = `${text.slice(0, truncatedOutputCharacters)}\n[Truncated at 12KB; open /dash for local details.]`;
  }
  return { content: [{ type: "text", text }], details: undefined };
}
function currentEvidence(run: WorkflowRun): {
  id: string | null | undefined;
  sourceStage: string | null | undefined;
  stageLabel: string;
  taskCoverage: ReturnType<typeof taskCoverage>;
  processObservation: string;
} {
  return {
    id: run.data.id,
    sourceStage: run.data.stage,
    stageLabel: stageLabel(run.data.stage ?? "unknown"),
    taskCoverage: taskCoverage(run.data.stage ?? "unknown"),
    processObservation: processObservation(run),
  };
}
function summary(state: Snapshot, legacy: boolean): ReadResult {
  const common = {
    hold: state.hold,
    installed: state.installed,
    main: state.main,
  };
  if (legacy) {
    const values = capacity(state.workflowRuns);
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
      jobs: state.workflowRuns
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
    capacity: observedCapacity(state.workflowRuns),
    coverage:
      "Bounded local reads; unavailable or malformed files may be omitted. Task results and parent links are not collected.",
    runs: state.workflowRuns
      .filter((run) => run.live !== false)
      .map((run) => ({
        ...currentEvidence(run),
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
  run: WorkflowRun,
  data: RunDetails,
  legacy: boolean,
): ReadResult {
  const launches = data.timeline.map((launch) => {
    const fields = {
      key: launch.key,
      kind: launch.kind,
      startedAt: launch.startedAt,
      seconds: launch.seconds,
      outcome: launch.outcome,
      turns: launch.turns,
      usage: launch.usage,
    };
    if (legacy) {
      return fields;
    }
    return { ...fields, label: executionLabel(launch.key) };
  });
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
  return result({ ...common, ...currentEvidence(run) });
}

export type { ReadResult };
export { detail, summary };
