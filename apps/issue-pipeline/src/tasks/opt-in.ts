// The opt-in task no signal activates: Safe Refactor. It always waits and
// never manufactures authority for itself. Its standalone tool
// (safe-refactor.mjs) still delivers its reports, which grant no pipeline
// result.

import type {
  ActionEnd,
  QualifiedSignal,
  Readiness,
  TaskView,
} from "../domain.ts";
import type { TaskModule } from "./module.ts";
import { ended } from "./module.ts";
import { sameItem } from "./sensing.ts";

const SAFE_REFACTOR_REFUSAL =
  "use safe-refactor.mjs; standalone reports grant no pipeline result";

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  if (!sameItem(signal, view)) {
    return null;
  }
  return { state: "waiting", reason: SAFE_REFACTOR_REFUSAL };
}

const refactorSafely: TaskModule = {
  definition: {
    id: "refactor-safely",
    role: "developer",
    access: "writer",
    sensors: [],
    resources: ["model-session"],
    match,
    act: (): Promise<ActionEnd> =>
      Promise.resolve(ended("refused", SAFE_REFACTOR_REFUSAL)),
  },
  prerequisite: () => SAFE_REFACTOR_REFUSAL,
  ownsResult: false,
  writesCode: false,
};

export { refactorSafely, SAFE_REFACTOR_REFUSAL };
