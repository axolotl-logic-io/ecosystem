// The two opt-in tasks, which no signal activates: Author and Safe
// Refactor. A start requests only Implement, so both always wait, and
// neither manufactures authority for itself. Safe Refactor's standalone
// tool (safe-refactor.mjs) still delivers its reports, which grant no
// pipeline result.

import type {
  ActionEnd,
  QualifiedSignal,
  Readiness,
  TaskView,
} from "../domain.ts";
import type { TaskModule } from "./module.ts";
import { ended } from "./module.ts";

const SAFE_REFACTOR_REFUSAL =
  "use safe-refactor.mjs; standalone reports grant no pipeline result";
const AUTHOR_REFUSAL =
  "Author has no activation signal; a start requests only Implement";

function waitsFor(reason: string) {
  return (signal: QualifiedSignal, view: TaskView): Readiness | null => {
    if (
      signal.workItem.repo.toLowerCase() !== view.workItem.repo.toLowerCase() ||
      signal.workItem.number !== view.workItem.number
    ) {
      return null;
    }
    return { state: "waiting", reason };
  };
}

const author: TaskModule = {
  definition: {
    id: "author",
    role: "developer",
    access: "writer",
    sensors: [],
    resources: ["model-session"],
    match: waitsFor(AUTHOR_REFUSAL),
    act: (): Promise<ActionEnd> =>
      Promise.resolve(ended("refused", AUTHOR_REFUSAL)),
  },
  prerequisite: () => AUTHOR_REFUSAL,
  ownsResult: false,
  writesCode: false,
};

const refactorSafely: TaskModule = {
  definition: {
    id: "refactor-safely",
    role: "developer",
    access: "writer",
    sensors: [],
    resources: ["model-session"],
    match: waitsFor(SAFE_REFACTOR_REFUSAL),
    act: (): Promise<ActionEnd> =>
      Promise.resolve(ended("refused", SAFE_REFACTOR_REFUSAL)),
  },
  prerequisite: () => SAFE_REFACTOR_REFUSAL,
  ownsResult: false,
  writesCode: false,
};

export { author, refactorSafely, SAFE_REFACTOR_REFUSAL };
