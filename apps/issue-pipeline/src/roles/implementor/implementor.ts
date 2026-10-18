// The implementor role (the wiki's Pipeline-Roles-Implementor): the stages
// its machine takes over, which registry.ts registers in one line, and the
// machine with its limits and what it writes.

import { maxConflictFixes } from "../../workflow/stages/conflict-resolver.ts";
import type { SweepConfig } from "../../workflow/stages/types.ts";
import type { Limits } from "../machine.ts";
import type { Machine } from "../walk.ts";
import type { ImplData, ImplState } from "./locate.ts";
import { locate } from "./locate.ts";
import type { ImplResult } from "./machine.ts";
import { LIMITS, TABLE } from "./machine.ts";

// The stages the implementor runs in stage jobs; a later part adds checks.
// The lanes' workflow.js keeps today's sync stage code.
const IMPLEMENTOR_STAGES: readonly string[] = ["implement", "fix", "sync"];

const implementorMachine: Machine<ImplState, ImplResult, ImplData> = {
  table: TABLE,
  limits: LIMITS,
  limitsOf: (cfg: SweepConfig): Limits => ({
    maxContinuations: cfg.maxContinuations,
    maxFixRounds: cfg.maxFixRounds,
    maxConflictFixes: maxConflictFixes({ cfg }),
    maxSyncs: cfg.maxSyncs,
  }),
  locate,
  handoff: [
    "headSha",
    "flows",
    "implemented",
    "reply",
    "findings",
    "round",
    "reviewedSha",
    "reviewedPatchId",
    "nextFindingId",
    "resolvedHistory",
    "testsOnly",
    "stackedOn",
    "syncs",
    "passedSha",
    "specTestsSha",
  ],
  checkpoints: [
    "continuations",
    "fixContinuations",
    "fixRounds",
    "conflictFixes",
    "ciFixRounds",
    "syncedHead",
  ],
};

export { IMPLEMENTOR_STAGES, implementorMachine };
