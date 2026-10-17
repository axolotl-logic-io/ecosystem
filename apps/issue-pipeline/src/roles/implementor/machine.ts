// The implementor role as a state machine (`role-state-machines`; the wiki's
// Pipeline-Roles-Implementor, "Lifecycle"): its table, its limits and its
// pure transition. Every run enters at the shared `start`; each entry's
// states live in their own module, which TABLE spreads in, so a later entry
// adds one module and one line here. Only `implementer` runs a model. The
// ops and checks are carried out by the job (checks.ts); this module only
// names them with their payloads.

import type { Limits, MachineState, Result, Step, Table } from "../machine.ts";
import { transitionOf } from "../machine.ts";
import { END_STATES } from "./ends.ts";
import { IMPLEMENT_STATES } from "./implement.ts";
import type { ImplData, ImplState } from "./locate.ts";
import { START_STATES } from "./start.ts";
import type { ImplResult } from "./states.ts";

// A continuation after each handoff, up to the config's maxContinuations
// (limitsOf), 1 by default.
const LIMITS: Limits = { maxContinuations: 1 };

const TABLE: Table<ImplState, ImplResult, ImplData> = {
  entries: ["start"],
  states: { ...START_STATES, ...IMPLEMENT_STATES, ...END_STATES },
};

const transition: (
  state: MachineState<ImplState, ImplData>,
  result: Result<ImplResult>,
) => Step<ImplState, ImplData> = transitionOf(TABLE, LIMITS);

export type { ImplResult } from "./states.ts";
export { LIMITS, TABLE, transition };
