// Fix: the Developer's answer to a change that didn't pass review
// (`fix-answers-reviews`). Verify's request-changes on the current head, a
// qualified person's request-changes review on it, or Land finding the PR
// conflicting with its base wakes it. In one run it merges the PR's base
// branch into its head branch, resolving any conflict, answers every
// blocking comment on the head with a code change and a thread reply,
// pushes through the development account and marks a draft PR ready. It
// binds a revision: the item PR's head. At most VERIFY_FIX_ROUNDS of its
// rounds per item may be Verify's (chain.ts verifyFixRounds); a further
// request-changes holds the item for a person (`review-loop-limit`).
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

const UNBUILT = "Fix is not built yet";

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, signal.kind);
  if (shared !== undefined) {
    return shared;
  }
  return { state: "waiting", reason: UNBUILT };
}

const fix: TaskModule = {
  definition: {
    id: "fix",
    role: "developer",
    access: "writer",
    sensors: ["result", "review", "stop"],
    resources: ["model-session", "test-slot"],
    match,
    act: (): Promise<ActionEnd> => Promise.resolve(ended("refused", UNBUILT)),
  },
  prerequisite: () => UNBUILT,
  ownsResult: false,
  writesCode: true,
};

export { fix };
