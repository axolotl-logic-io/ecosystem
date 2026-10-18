// The implementor role (the wiki's Pipeline-Roles-Implementor): the stages
// its machine takes over, which registry.ts registers in one line, and the
// machine with its limits and what it writes.

import type { SweepConfig } from "../../workflow/stages/types.ts";
import type { Limits } from "../machine.ts";
import type { Machine } from "../walk.ts";
import type { ImplData, ImplState } from "./locate.ts";
import { locate } from "./locate.ts";
import type { ImplResult } from "./machine.ts";
import { LIMITS, TABLE } from "./machine.ts";

// The stages the implementor runs; later parts add theirs.
const IMPLEMENTOR_STAGES: readonly string[] = ["implement", "fix"];

const implementorMachine: Machine<ImplState, ImplResult, ImplData> = {
  table: TABLE,
  limits: LIMITS,
  limitsOf: (cfg: SweepConfig): Limits => ({
    maxContinuations: cfg.maxContinuations,
    maxFixRounds: cfg.maxFixRounds,
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
  ],
  checkpoints: [
    "continuations",
    "fixContinuations",
    "fixRounds",
    "conflictFixes",
    "ciFixRounds",
  ],
};

export { IMPLEMENTOR_STAGES, implementorMachine };
