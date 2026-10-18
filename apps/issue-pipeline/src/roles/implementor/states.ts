// What the implementor's states are built from (the wiki's
// Pipeline-Roles-Implementor, "Lifecycle"): the results they answer with, a
// state's spec, and the script states that run a check or an op. Each
// entry's module (start.ts, sync.ts, implement.ts, fix.ts, checks-entry.ts)
// builds its states from these, and machine.ts joins them. Pure.

import type { Edge, StateSpec } from "../machine.ts";
import type { ImplData, ImplState } from "./locate.ts";

// The results the states answer with. `failed` is also what the walk gives
// an effect that failed (walk.ts).
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
  | "reintroduced"
  // The start sync's and the `sync` entry's (#419).
  | "sync"
  | "clean"
  | "conflict"
  | "fixed"
  | "cannot-fix"
  | "rejected"
  | "aborted"
  | "failed"
  | "moved"
  | "same"
  // The `checks` entry's (#420), beside the ones above it shares.
  | "checks"
  | "verified"
  | "pass"
  | "wiki-only"
  | "fail"
  | "green"
  | "pending"
  | "no-checks"
  | "blocking";

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

// A script state that runs op `name` with `payload` and the issue, and goes
// on by `ok` once it is done; the runner ends a run whose op failed.
function op(
  name: string,
  payload: (data: ImplData) => Payload,
  ok: Edge<ImplState, ImplData>,
): ImplSpec {
  return {
    kind: "script",
    effect: (data: ImplData) => ({
      kind: "op",
      op: name,
      payload: { number: data.issue, ...payload(data) },
    }),
    on: { ok },
  };
}

export type { ImplResult, ImplSpec, ImplStates };
export { check, op };
