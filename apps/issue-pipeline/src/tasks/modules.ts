// Every task's module, by canonical id: its domain definition and what it
// owns beside it (module.ts).

import type { TaskId } from "../domain.ts";
import { complete } from "./complete.ts";
import { harden } from "./harden.ts";
import { implement } from "./implement.ts";
import { integrate } from "./integrate.ts";
import { land } from "./land.ts";
import type { TaskModule } from "./module.ts";
import { author, refactorSafely } from "./opt-in.ts";
import { reviewSecurity } from "./review-security.ts";
import { sync } from "./sync.ts";

const MODULES: Readonly<Record<TaskId, TaskModule>> = {
  author,
  implement,
  harden,
  sync,
  integrate,
  "review-security": reviewSecurity,
  land,
  complete,
  "refactor-safely": refactorSafely,
};

export { MODULES };
