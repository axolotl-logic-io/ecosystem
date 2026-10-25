import { empty, type Snapshot } from "../data.ts";
import type { HistoricalJob } from "../job-history.ts";
import type { JobData } from "../source-records.ts";

function makeRun(
  data: Partial<JobData> = {},
  overrides: Partial<Omit<HistoricalJob, "data">> = {},
): HistoricalJob {
  return {
    repo: "axolotl-logic-io/project-buddy",
    issue: 1,
    dir: "/nonexistent/workflow-dash-fixture",
    live: true,
    records: [],
    ...overrides,
    data: { launches: [], ...data },
  };
}
function makeState(overrides: Partial<Snapshot> = {}): Snapshot {
  return { ...empty, jobHistory: [], subagentRuns: [], ...overrides };
}

export { makeRun, makeState };
