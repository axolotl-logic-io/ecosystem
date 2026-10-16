// The sweep's settings: the token budgets, models and spawn cap a repo config
// may override, and the fixed facts about each stage that the sweep's driver
// plans with (how many spawns a run of it can take, how often it may begin in
// one sweep, which stages save first, and the order the stages run in).

import type { JobCheckout } from "../config.ts";
import type { Budgets } from "./budget.ts";
import type { ModelRole, StageName, SweepConfig } from "./stages/types.ts";
import type { Role } from "./types.ts";

// Each role's token budget per session, unless the config's roleBudgets sets it.
const ROLE_BUDGETS: Readonly<Record<Role, number>> = {
  triage: 50_000,
  spec: 80_000,
  implementer: 150_000,
  reviewer: 60_000,
  aggregator: 20_000,
  fixer: 100_000,
  rereviewer: 40_000,
  ciFixer: 100_000,
  verifier: 60_000,
};

// Each role's model, unless the config's models sets it.
const MODELS: Readonly<Record<ModelRole, string>> = {
  triage: "anthropic/claude-opus-5-5",
  spec: "anthropic/claude-opus-5-5",
  implementer: "anthropic/claude-opus-5-5",
  correctness: "anthropic/claude-opus-5-5",
  tests: "anthropic/claude-opus-5-5",
  scope: "anthropic/claude-sonnet-5-5",
  aggregator: "anthropic/claude-sonnet-5-5",
  fixer: "anthropic/claude-opus-5-5",
  verifier: "anthropic/claude-sonnet-5-5",
  security: "anthropic/claude-opus-5-5",
  acceptance: "anthropic/claude-sonnet-5-5",
};

// pi-subagents' own per-run spawn cap (maxSubagentSpawnsPerRun), unless the
// config's maxSpawnsPerRun sets the sweep's.
const DEFAULT_SPAWN_LIMIT = 64;

// The most children one run of each stage can spawn, ops steps included.
const STAGE_SPAWNS: Readonly<Record<StageName, number>> = {
  triage: 4,
  spec: 3,
  implement: 1,
  "open-pr": 2,
  review: 7,
  fix: 8,
  sync: 3,
  checks: 11,
  accept: 3,
  security: 3,
  merge: 5,
  publish: 4,
};

// Why the sweep stops an issue still at a stage once its stage group ends and
// the issue isn't held: it has used every pass.
const PASSES_USED: Readonly<Partial<Record<StageName, string>>> = {
  implement: "implementation did not finish within its sessions",
};

// The stages the sweep saves the issue's state before it first begins.
const SAVE_BEFORE: readonly StageName[] = ["spec", "implement", "review"];

// The stage groups, in the order the sweep runs them. Within a group, the
// sweep begins whichever stage the issue reaches, so an issue moves through
// as many stages as fit; the queued stops are posted after each group.
const STAGE_GROUPS: readonly (readonly StageName[])[] = [
  ["triage", "spec", "implement", "open-pr"],
  ["review", "fix"],
  ["sync", "checks"],
  ["accept", "security", "merge", "publish"],
];

// Every stage, in the order an issue moves through them.
const STAGE_ORDER: readonly StageName[] = STAGE_GROUPS.flat();

// The stage a run's stage arg names: args.through, the last stage a run may
// begin, or args.stage, the only one. Null when the arg is unset. An unknown
// stage name throws before the sweep launches anything, naming the arg.
function stageArgOf(name: string, value: unknown): StageName | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const stage = STAGE_ORDER.find((entry) => entry === String(value));
  if (stage === undefined) {
    throw new Error(`args.${name} must be one of: ${STAGE_ORDER.join(", ")}`);
  }
  return stage;
}

// The run's args as pi-subagents or the stage job passes them: the repo
// config's path, the lane, the one issue a human launched the run for, if
// any, whether to take it even when stopped (takeStopped), the last stage
// (through) or only stage (stage) it may begin, a stage job's checkout,
// which every request then names, and the merge order the orchestrator
// ranked (mergeQueue).
interface SweepArgs {
  config: string;
  checkout?: JobCheckout;
  lane?: unknown;
  issue?: unknown;
  takeStopped?: unknown;
  through?: unknown;
  stage?: unknown;
  mergeQueue?: unknown;
}

// The issues a run may take: the one a human launched it for, or null for
// every candidate, and whether it takes that issue even with a stop label.
interface SweepTarget {
  only: number | null;
  takeStopped: boolean;
}

// The run's target from args.issue and args.takeStopped, which counts only as
// the boolean true.
function sweepTargetOf(issue: unknown, takeStopped: unknown): SweepTarget {
  let only: number | null = Number(issue);
  if (Number.isNaN(only) || only === 0) {
    only = null;
  }
  return { only, takeStopped: takeStopped === true };
}

// The merge order the orchestrator ranked (args.mergeQueue, #234): issue
// numbers as an array or a comma-separated string. Null when unset; an entry
// that isn't a positive integer throws before the sweep launches anything.
function mergeQueueOf(value: unknown): readonly number[] | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  let entries: readonly unknown[] = String(value).split(",");
  if (Array.isArray(value)) {
    entries = value;
  }
  const queue = entries.map(Number);
  if (!queue.every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error("args.mergeQueue must list issue numbers");
  }
  return queue;
}

// What a run's args pin: the issues it may take (args.issue and
// args.takeStopped), the last stage it may begin (args.through), the only one
// (args.stage) and the merge order (args.mergeQueue).
interface RunPins {
  target: SweepTarget;
  through: StageName | null;
  stage: StageName | null;
  mergeQueue: readonly number[] | null;
}

function runPinsOf(args: SweepArgs): RunPins {
  return {
    target: sweepTargetOf(args.issue, args.takeStopped),
    through: stageArgOf("through", args.through),
    stage: stageArgOf("stage", args.stage),
    mergeQueue: mergeQueueOf(args.mergeQueue),
  };
}

// Whether a run that may begin stages up to `through` may begin `stage`.
function within(through: StageName | null, stage: StageName): boolean {
  return (
    through === null ||
    STAGE_ORDER.indexOf(stage) <= STAGE_ORDER.indexOf(through)
  );
}

// The settings the config gives the sweep, the defaults first.
interface SweepSettings {
  budgets: Budgets;
  models: Readonly<Record<ModelRole, string>>;
  spawnLimit: number;
}

// The config's spawn cap, unless it is missing, null, zero or NaN.
function spawnLimitOf(limit: number | null | undefined): number {
  if (
    limit === undefined ||
    limit === null ||
    limit === 0 ||
    Number.isNaN(limit)
  ) {
    return DEFAULT_SPAWN_LIMIT;
  }
  return limit;
}

function sweepSettings(cfg: SweepConfig): SweepSettings {
  return {
    budgets: {
      roles: { ...ROLE_BUDGETS, ...cfg.roleBudgets },
      sessionCap: cfg.sessionTokenCap,
      hardLimit: cfg.contextLimits.hard,
      issueBudget: cfg.issueTokenBudget,
      rebaseBudget: cfg.rebaseTokenBudget,
    },
    models: { ...MODELS, ...cfg.models },
    spawnLimit: spawnLimitOf(cfg.maxSpawnsPerRun),
  };
}

// How many times a sweep may begin `stage`: once, and implement once more for
// each continuation from a handoff the config allows.
function passesOf(stage: StageName, maxContinuations: number): number {
  if (stage === "implement") {
    return 1 + maxContinuations;
  }
  return 1;
}

// The run's lane: the one its args name, or else the sweep's id.
function laneOf(args: { lane?: unknown }, sweepId: string): string {
  const { lane } = args;
  const named = Boolean(lane);
  if (named) {
    return String(lane);
  }
  return sweepId;
}

export type { RunPins, SweepArgs, SweepSettings, SweepTarget };
export {
  laneOf,
  PASSES_USED,
  passesOf,
  runPinsOf,
  SAVE_BEFORE,
  STAGE_GROUPS,
  STAGE_ORDER,
  STAGE_SPAWNS,
  spawnLimitOf,
  sweepSettings,
  sweepTargetOf,
  within,
};
