// Every task's module, by canonical id: its domain definition and what it
// owns beside it (module.ts).

import type { TaskId } from "../domain.ts";
import { fix } from "./fix.ts";
import { implement } from "./implement.ts";
import { land } from "./land.ts";
import type { TaskModule } from "./module.ts";
import { refactorSafely } from "./opt-in.ts";
import { verify } from "./verify.ts";

const MODULES: Readonly<Record<TaskId, TaskModule>> = {
  implement,
  verify,
  fix,
  land,
  "refactor-safely": refactorSafely,
};

export { MODULES };
