// How a config written for the installed version loads in this one: its
// removed fields are dropped with a warning, never fatal, and its old model
// roles map to the three model roles (`three-configurable-models`).

import { z } from "zod";

type ModelRole = "author" | "implementor" | "reviewer";

// The model a role gets when the config names none for it, or for the
// installed version's roles it maps from. Explicit configured models stay unchanged.
const DEFAULT_MODEL = "openai/gpt-6.1-sol";

// The installed version's model roles each role reads, in order, when the
// config's models doesn't name the role itself.
const LEGACY_MODEL_ROLES: Readonly<Record<ModelRole, readonly string[]>> = {
  author: ["spec", "triage"],
  implementor: ["implementer", "fixer"],
  reviewer: ["correctness", "security", "tests"],
};

const MODEL_ROLES: readonly ModelRole[] = ["author", "implementor", "reviewer"];

const SESSION_BUDGETS = "session budgets and handoffs were removed";
const OLD_ROLES = "the triage and practices-digest roles were removed";
const CLAIM_RACE = "the claim race was removed";
const TEST_RULES =
  "the reviewer judges tests; the mechanical test rules were removed";
const ORCHESTRATOR_EXTRAS =
  "the orchestrator's escalation and spawn limits were removed";

// Fields the pipeline no longer reads, each with what removed it. A config
// that sets one still loads, with a warning.
const REMOVED_FIELDS: Readonly<Record<string, string>> = {
  claimCandidates: CLAIM_RACE,
  claimWaitSeconds: CLAIM_RACE,
  contextLimits: SESSION_BUDGETS,
  failureStreak: ORCHESTRATOR_EXTRAS,
  issueTokenBudget: SESSION_BUDGETS,
  maxContinuations: SESSION_BUDGETS,
  maxFixRounds: "hardening owns fixes; review rounds were removed",
  maxSpawnsPerRun: ORCHESTRATOR_EXTRAS,
  maxTriages: OLD_ROLES,
  nonCodePathGlobs: TEST_RULES,
  orchestratorRoles: ORCHESTRATOR_EXTRAS,
  practicesDigest: OLD_ROLES,
  rebaseTokenBudget: SESSION_BUDGETS,
  requireNewTests: TEST_RULES,
  roleBudgets: SESSION_BUDGETS,
  sessionTokenCap: SESSION_BUDGETS,
  silentMinutes: ORCHESTRATOR_EXTRAS,
  testPathGlobs: TEST_RULES,
  tokensPerHour: SESSION_BUDGETS,
};
// Every escalation agent field (escalationAgentModel and the rest).
const REMOVED_PREFIX = "escalationAgent";

const MODEL_IDS = z.record(z.string(), z.unknown()).catch({});

interface ModelChoice {
  models: Record<ModelRole, string>;
  warnings: string[];
}

function textModel(value: unknown): string | null {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  return null;
}

// The first of `role`'s own key and its installed-version keys that names a
// model in `given`, or undefined.
function modelKey(
  role: ModelRole,
  given: Readonly<Record<string, unknown>>,
): string | undefined {
  return [role, ...LEGACY_MODEL_ROLES[role]].find(
    (name) => textModel(given[name]) !== null,
  );
}

// Each role's model from the config's `models`: the role's own key, else the
// first installed-version role it maps from, else DEFAULT_MODEL. Every key it
// didn't use is named in a warning.
function chooseModels(raw: unknown): ModelChoice {
  const given = MODEL_IDS.parse(raw ?? {});
  const used = new Set<string>();
  const warnings: string[] = [];
  const models: Record<ModelRole, string> = {
    author: DEFAULT_MODEL,
    implementor: DEFAULT_MODEL,
    reviewer: DEFAULT_MODEL,
  };
  for (const role of MODEL_ROLES) {
    const key = modelKey(role, given);
    if (key !== undefined) {
      used.add(key);
      models[role] = textModel(given[key]) ?? DEFAULT_MODEL;
    }
    if (key !== undefined && key !== role) {
      warnings.push(
        `models.${key} is the installed version's role; the ${role} uses its model ${models[role]} (set models.${role} to choose)`,
      );
    }
  }
  for (const key of Object.keys(given).filter((name) => !used.has(name))) {
    warnings.push(`models.${key} is no longer read; ignoring it`);
  }
  return { models, warnings };
}

// Why the pipeline no longer reads `key`, or null when it still does.
function removalReason(key: string): string | null {
  if (Object.hasOwn(REMOVED_FIELDS, key)) {
    const { [key]: reason } = REMOVED_FIELDS;
    return reason ?? null;
  }
  if (key.startsWith(REMOVED_PREFIX)) {
    return ORCHESTRATOR_EXTRAS;
  }
  return null;
}

// The config's keys without the removed ones, with the models chosen, and a
// warning for each removed key and each model key it maps or ignores.
function withoutRemovedKeys(raw: Readonly<Record<string, unknown>>): {
  kept: Record<string, unknown>;
  warnings: string[];
} {
  const kept: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const reason = removalReason(key);
    if (reason === null) {
      kept[key] = value;
    } else {
      warnings.push(`${key} is no longer read (${reason}); ignoring it`);
    }
  }
  const { models } = raw;
  const choice = chooseModels(models);
  return {
    kept: { ...kept, models: choice.models },
    warnings: [...warnings, ...choice.warnings],
  };
}

export type { ModelRole };
export { chooseModels, withoutRemovedKeys };
