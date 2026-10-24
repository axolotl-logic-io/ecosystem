import { empty, type Snapshot } from "../data.ts";
import type { WorkflowData } from "../source-records.ts";
import type { WorkflowRun } from "../workflow-source.ts";

function makeRun(
  data: Partial<WorkflowData> = {},
  overrides: Partial<Omit<WorkflowRun, "data">> = {},
): WorkflowRun {
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
  return { ...empty, workflowRuns: [], buddyRuns: [], ...overrides };
}

export { makeRun, makeState };
