// The sweep's settings: the token budgets, models and spawn cap a repo config
// may override, and the fixed facts about each stage that the sweep's driver
// plans with (how many spawns a run of it can take, how often it may begin in
// one sweep, which stages save first, and the order the stages run in).

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
  accept: 2,
  security: 3,
  merge: 2,
};

// How many times a sweep may begin a stage (default 1): implement runs once
// more to continue from a handoff.
const STAGE_PASSES: Readonly<Partial<Record<StageName, number>>> = {
  implement: 2,
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
  ["accept", "security", "merge"],
];

// Every stage, in the order an issue moves through them.
const STAGE_ORDER: readonly StageName[] = STAGE_GROUPS.flat();

// The last stage a run may begin, from args.through: null for every stage.
// An unknown stage name throws before the sweep launches anything.
function throughOf(through: unknown): StageName | null {
  if (through === undefined || through === null || through === "") {
    return null;
  }
  const stage = STAGE_ORDER.find((name) => name === String(through));
  if (stage === undefined) {
    throw new Error(
      `args.through must be one of: ${STAGE_ORDER.join(", ")}`,
    );
  }
  return stage;
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
      issueBudget: cfg.issueTokenBudget,
    },
    models: { ...MODELS, ...cfg.models },
    spawnLimit: spawnLimitOf(cfg.maxSpawnsPerRun),
  };
}

// How many times a sweep may begin `stage`.
function passesOf(stage: StageName): number {
  const { [stage]: passes = 1 } = STAGE_PASSES;
  return passes;
}

export type { SweepSettings };
export {
  PASSES_USED,
  passesOf,
  SAVE_BEFORE,
  STAGE_GROUPS,
  STAGE_SPAWNS,
  sweepSettings,
  throughOf,
  within,
};
