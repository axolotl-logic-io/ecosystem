// The implementor role as a state machine (`role-state-machines`; the wiki's
// Pipeline-Roles-Implementor, "Lifecycle"): its table, its limits and its
// pure transition. Every run enters at the shared `start`, then passes
// through the start sync (#419); each entry's states live in their own
// module, which TABLE spreads in, so a later entry adds one module and one
// line here. The sessions are the implementer, the fixer, the re-reviewers
// and the conflict resolver. The ops and checks are carried out by the job
// (checks.ts); this module only names them with their payloads.

import type { Limits, MachineState, Result, Step, Table } from "../machine.ts";
import { transitionOf } from "../machine.ts";
import { END_STATES } from "./ends.ts";
import { FIX_STATES } from "./fix.ts";
import { IMPLEMENT_STATES } from "./implement.ts";
import type { ImplData, ImplState } from "./locate.ts";
import { START_STATES } from "./start.ts";
import type { ImplResult } from "./states.ts";
import { SYNC_STATES } from "./sync.ts";

// A continuation after each handoff, up to the config's maxContinuations,
// fix rounds up to its maxFixRounds, conflict resolutions up to its
// maxConflictFixes and the sync entry's rebases up to its maxSyncs
// (limitsOf): 1, 2, 2 and 3 by default.
const LIMITS: Limits = {
  maxContinuations: 1,
  maxFixRounds: 2,
  maxConflictFixes: 2,
  maxSyncs: 3,
};

const TABLE: Table<ImplState, ImplResult, ImplData> = {
  entries: ["start"],
  states: {
    ...START_STATES,
    ...SYNC_STATES,
    ...IMPLEMENT_STATES,
    ...FIX_STATES,
    ...END_STATES,
  },
};

const transition: (
  state: MachineState<ImplState, ImplData>,
  result: Result<ImplResult>,
) => Step<ImplState, ImplData> = transitionOf(TABLE, LIMITS);

export type { ImplResult } from "./states.ts";
export { LIMITS, TABLE, transition };
