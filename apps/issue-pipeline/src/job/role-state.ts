// What a role's run writes to the issue's state: the state it last saved, at
// the run's stage, with only the hand-off fields and checkpoints the role
// declares taken from its `data`. Checkpoints are kept in the state's
// `checkpoints` record, so a value a later start needs survives a restart.

import type { Writes } from "../roles/walk.ts";
import type { State } from "../state.ts";

type Checkpoints = Record<string, number | string | null>;

// The declared checkpoints `data` holds a number, text or null for.
function checkpointsOf<D>(data: D, writes: Writes<D>): Checkpoints {
  const found: Checkpoints = {};
  for (const key of writes.checkpoints) {
    const value: unknown = data[key];
    if (
      typeof value === "number" ||
      typeof value === "string" ||
      value === null
    ) {
      found[key] = value;
    }
  }
  return found;
}

// Whether a declared checkpoint in `data` differs from the one `saved` holds.
function checkpointsChanged<D>(
  data: D,
  writes: Writes<D>,
  saved: State,
): boolean {
  const before = saved.checkpoints ?? {};
  return Object.entries(checkpointsOf(data, writes)).some(
    ([key, value]): boolean => before[key] !== value,
  );
}

// The state to save at `stage`; an end's save drops the lease.
function writtenState<D>(
  from: { saved: State; stage: string; writes: Writes<D> },
  data: D,
  end: boolean,
): State {
  const { saved, stage, writes } = from;
  const checkpoints = { ...saved.checkpoints, ...checkpointsOf(data, writes) };
  const state: State = { ...saved, stage, checkpoints };
  for (const key of writes.handoff) {
    state[key] = data[key];
  }
  if (end) {
    return { ...state, lease: null };
  }
  return state;
}

export { checkpointsChanged, writtenState };
