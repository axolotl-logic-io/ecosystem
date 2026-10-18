// What the implementor's states are built from (the wiki's
// Pipeline-Roles-Implementor, "Lifecycle"): the results they answer with, a
// state's spec, and the script state that runs a check. Each entry's module
// (start.ts, implement.ts) builds its states from these, and machine.ts
// joins them. Pure.

import type { StateSpec } from "../machine.ts";
import type { ImplData, ImplState } from "./locate.ts";

// The results the states answer with.
type ImplResult =
  | "ok"
  | "replied"
  | "implement"
  | "work"
  | "built"
  | "none"
  | "done"
  | "handoff"
  | "blocked"
  | "bad"
  | "code"
  // The `fix` entry's (#418).
  | "fix"
  | "open"
  | "acceptance"
  | "go"
  | "reopen"
  | "resolved"
  | "reintroduced";

type ImplSpec = StateSpec<ImplState, ImplResult, ImplData>;

// The specs of the states named `K`.
type ImplStates<K extends ImplState> = Readonly<Record<K, ImplSpec>>;

type Payload = Readonly<Record<string, unknown>>;

// A script state that runs check `name` with `payload` and the issue, and
// routes on its answer.
function check(
  name: string,
  payload: (data: ImplData) => Payload,
  on: ImplSpec["on"],
): ImplSpec {
  return {
    kind: "script",
    effect: (data: ImplData) => ({
      kind: "check",
      check: name,
      payload: { number: data.issue, ...payload(data) },
    }),
    on,
  };
}

export type { ImplResult, ImplSpec, ImplStates };
export { check };
