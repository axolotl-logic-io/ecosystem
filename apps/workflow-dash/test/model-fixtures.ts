import { empty, type Snapshot } from "../data.ts";

function makeState(overrides: Partial<Snapshot> = {}): Snapshot {
  return { ...empty, subagentRuns: [], ...overrides };
}

export { makeState };
