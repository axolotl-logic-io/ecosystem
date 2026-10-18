// The implementor's shared start (the wiki's Pipeline-Roles-Implementor,
// "Lifecycle"): every run begins here, and its check answers with the
// entry the run takes. The start sync (#419) will run here first. Pure.

import type { ImplData } from "./locate.ts";
import type { ImplStates } from "./states.ts";
import { check } from "./states.ts";

const START_STATES: ImplStates<"start"> = {
  start: check("start", (data: ImplData) => ({ entry: data.entry }), {
    implement: { to: "implement-work?" },
    fix: { to: "fix-work?" },
  }),
};

export { START_STATES };
