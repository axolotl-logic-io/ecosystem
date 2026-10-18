// The implementor's shared start (the wiki's Pipeline-Roles-Implementor,
// "Lifecycle"): every run begins here, and its check answers with the
// entry the run takes. Every entry goes on to the start sync (sync.ts,
// #419), which leads to the entry's first state. Pure.

import type { ImplData } from "./locate.ts";
import type { ImplStates } from "./states.ts";
import { check } from "./states.ts";

const START_STATES: ImplStates<"start"> = {
  start: check("start", (data: ImplData) => ({ entry: data.entry }), {
    implement: { to: "sync-work?" },
    fix: { to: "sync-work?" },
    sync: { to: "sync-work?" },
  }),
};

export { START_STATES };
