// The stage groups of a sweep. Within a group the issue's stage begins, steps
// through its machine and finishes, and the next stage the issue reaches in
// the group begins, while it has passes left this sweep and fits under the
// spawn cap. A stage the sweep saves before is saved before it first begins,
// even if the cap then holds it. Once no stage in a group begins, an issue
// still at a stage whose passes are used up is stopped, and the stops queued
// in the group are posted.

import { launchResults } from "./launch-results.ts";
import type { LaunchSpec } from "./launches.ts";
import { STAGES } from "./stages/index.ts";
import type {
  LaunchStep,
  OpLaunch,
  StageMachine,
  StageName,
  Step,
} from "./stages/types.ts";
import {
  PASSES_USED,
  passesOf,
  SAVE_BEFORE,
  STAGE_GROUPS,
  within,
} from "./sweep-config.ts";
import type { ClaimedItem, SweepRun } from "./sweep-item.ts";
import {
  applyStep,
  fits,
  opsLaunchSpec,
  stageState,
  stopIssue,
} from "./sweep-item.ts";

// What a stage group awaits: the stops posted after group `group` (-1 for
// the claim), the save before a stage in it first begins, or a stage's
// launches.
type StagePhase =
  | { kind: "flush"; group: number }
  | { kind: "save"; group: number }
  | { kind: "stage"; group: number; machine: StageMachine; step: LaunchStep };

// The group a stage runs in, and its machine.
interface StageAt {
  group: number;
  machine: StageMachine;
}

interface StageBatch {
  phase: StagePhase;
  specs: LaunchSpec[];
}

// The open issue, its stage and how often that stage has begun this sweep,
// if the stage is one of the group's and within the run's args.through.
interface CurrentStage {
  item: ClaimedItem;
  stage: StageName;
  runs: number;
}

function currentStage(run: SweepRun, group: number): CurrentStage | null {
  const { item } = run;
  if (item?.kind !== "claimed" || item.closed) {
    return null;
  }
  const stages = STAGE_GROUPS[group] ?? [];
  const stage = stages.find((name) => name === item.st.stage);
  if (stage === undefined || !within(run.through, stage)) {
    return null;
  }
  const { [stage]: runs = 0 } = run.stagesRun;
  return { item, stage, runs };
}

// The step's launches as the group's next batch, or null for a done step.
function stepBatch(
  run: SweepRun,
  item: ClaimedItem,
  at: StageAt,
  step: Step,
): StageBatch | null {
  const specs = applyStep(run, item, step);
  if (step.done) {
    return null;
  }
  return { phase: { kind: "stage", ...at, step }, specs };
}

// The group's next batch: the save before the issue's stage first begins
// (unless it was just made), or the launches of the stage's first step. A
// stage done at once lets the next one begin. Null once no stage begins.
function groupBatch(
  run: SweepRun,
  group: number,
  saved: boolean,
): StageBatch | null {
  const current = currentStage(run, group);
  if (current === null) {
    return null;
  }
  const { item, stage, runs } = current;
  if (!saved && runs === 0 && SAVE_BEFORE.includes(stage)) {
    const payload = { number: item.n, state: item.st };
    const name = `i${item.n}-save`;
    const save: OpLaunch = { kind: "op", name, op: "save-state", payload };
    return {
      phase: { kind: "save", group },
      specs: [opsLaunchSpec(run, save)],
    };
  }
  if (runs >= passesOf(stage) || !fits(run, item, stage)) {
    return null;
  }
  run.stagesRun = { ...run.stagesRun, [stage]: runs + 1 };
  const machine = STAGES[stage];
  const step = machine.next(stageState(item, "begin", null), run.ctx, []);
  return (
    stepBatch(run, item, { group, machine }, step) ??
    groupBatch(run, group, false)
  );
}

// Stops an issue still at a stage of the group whose passes are used up,
// unless the spawn cap held it there.
function stopUnfinished(run: SweepRun, group: number): void {
  const current = currentStage(run, group);
  if (current === null || current.item.held) {
    return;
  }
  const { [current.stage]: reason } = PASSES_USED;
  if (reason !== undefined) {
    stopIssue(run, current.item, { reason, detail: null, code: null });
  }
}

// The next batch from group `group` on, the first time through if `saved`
// is false: each group runs until no stage begins, then posts its stops.
// Null once every group has ended.
function groupsFrom(
  run: SweepRun,
  group: number,
  saved: boolean,
): StageBatch | null {
  if (group >= STAGE_GROUPS.length) {
    return null;
  }
  const batch = groupBatch(run, group, saved);
  if (batch !== null) {
    return batch;
  }
  stopUnfinished(run, group);
  return flushBatch(run, group) ?? groupsFrom(run, group + 1, false);
}

// The stops queued by group `group`, or null if there are none.
function flushBatch(run: SweepRun, group: number): StageBatch | null {
  const specs = run.stopQueue.splice(0, run.stopQueue.length);
  if (specs.length === 0) {
    return null;
  }
  return { phase: { kind: "flush", group }, specs };
}

// The batch after the claim: its stops, then the stage groups.
function afterClaim(run: SweepRun): StageBatch | null {
  return flushBatch(run, -1) ?? groupsFrom(run, 0, false);
}

// Takes the raw results of a stage group's batch and returns the next batch,
// or null once every group has ended.
function stageResults(
  run: SweepRun,
  phase: StagePhase,
  raw: readonly unknown[],
): StageBatch | null {
  switch (phase.kind) {
    case "flush":
      return groupsFrom(run, phase.group + 1, false);
    case "save":
      return groupsFrom(run, phase.group, true);
    case "stage":
      return stepResults(run, phase, raw);
    default:
      return unreachable(phase);
  }
}

function stepResults(
  run: SweepRun,
  phase: Extract<StagePhase, { kind: "stage" }>,
  raw: readonly unknown[],
): StageBatch | null {
  const { item } = run;
  if (item?.kind !== "claimed") {
    return groupsFrom(run, phase.group, false);
  }
  const { group, machine, step } = phase;
  const results = launchResults(step.launches, raw, item.st, run.meta);
  const state = stageState(item, step.state.phase, step.state.carry);
  const nextStep = machine.next(state, run.ctx, results);
  return (
    stepBatch(run, item, { group, machine }, nextStep) ??
    groupsFrom(run, group, false)
  );
}

function unreachable(value: never): never {
  throw new Error(`sweep: unexpected phase ${JSON.stringify(value)}`);
}

export type { StageBatch, StagePhase };
export { afterClaim, stageResults };
