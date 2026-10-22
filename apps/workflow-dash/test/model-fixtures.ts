import type { BuddyRun } from "../buddy-runs.ts";
import { empty, type Snapshot } from "../data.ts";
import type { Choice, ViewHost } from "../selection.ts";
import type { WorkflowData } from "../source-records.ts";
import type { WorkflowRun } from "../workflow-source.ts";

interface ViewFixture {
  host: ViewHost;
  choices: Choice[];
  done: (choice: Choice) => void;
  close: () => void;
  closed: () => boolean;
  renderRequests: () => number;
}
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
function makeBuddy(overrides: Partial<BuddyRun> = {}): BuddyRun {
  return {
    id: "buddy-fixture",
    state: "running",
    mission: "fixture mission",
    account: null,
    accountSource: "synthetic fixture; no account evidence",
    pending: "none",
    tail: "",
    ...overrides,
  };
}
function makeState(overrides: Partial<Snapshot> = {}): Snapshot {
  return { ...empty, workflowRuns: [], buddyRuns: [], ...overrides };
}
function viewFixture(rows = 40): ViewFixture {
  let renders = 0;
  let closed = false;
  const choices: Choice[] = [];
  return {
    host: {
      terminal: { rows },
      requestRender: (): void => {
        renders += 1;
      },
    },
    choices,
    done: (choice: Choice): void => {
      choices.push(choice);
    },
    close: (): void => {
      closed = true;
    },
    closed: () => closed,
    renderRequests: () => renders,
  };
}

export type { ViewFixture };
export { makeBuddy, makeRun, makeState, viewFixture };
