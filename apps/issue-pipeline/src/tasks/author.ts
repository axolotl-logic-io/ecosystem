// Author: the Developer's Gherkin requirements for the issue, requested by
// `start:author` for the issue's current requirements (`start-labels`). It
// binds the trusted requirements and writes no code.
//
// Not built yet: it waits on every signal and refuses any action, so it
// records nothing.

import type {
  ActionEnd,
  QualifiedSignal,
  Readiness,
  TaskView,
} from "../domain.ts";
import type { TaskModule } from "./module.ts";
import { ended } from "./module.ts";
import { sensed } from "./sensing.ts";

const UNBUILT = "Author is not built yet";

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, "start");
  if (shared !== undefined) {
    return shared;
  }
  if (signal.kind !== "start" || signal.task !== "author") {
    return null;
  }
  return { state: "waiting", reason: UNBUILT };
}

const author: TaskModule = {
  definition: {
    id: "author",
    role: "developer",
    access: "writer",
    sensors: ["start", "stop"],
    resources: ["model-session"],
    match,
    act: (): Promise<ActionEnd> => Promise.resolve(ended("refused", UNBUILT)),
  },
  prerequisite: () => UNBUILT,
  ownsResult: false,
  writesCode: false,
};

export { author };
