// Verify: the Gatekeeper's check of one exact PR head, reported as a GitHub
// review the landing account submits against that head's commit
// (`verify-reviews-the-pr`). It runs the repository's full checks, the
// required CI and the Security review of the head; it approves when it
// finds nothing or only nits and requests changes otherwise, and a Security
// finding always blocks. It binds a revision: the item PR's head. It becomes
// ready for a head with no Verify result, or for `start:verify`. Its result
// mirrors its review (domain.ts VERIFY_EVIDENCE): passed for an approval,
// refused for a request for changes.
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

const UNBUILT = "Verify is not built yet";

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, signal.kind);
  if (shared !== undefined) {
    return shared;
  }
  return { state: "waiting", reason: UNBUILT };
}

const verify: TaskModule = {
  definition: {
    id: "verify",
    role: "gatekeeper",
    access: "reader",
    sensors: ["start", "result", "stop"],
    resources: ["model-session", "test-slot"],
    match,
    act: (): Promise<ActionEnd> => Promise.resolve(ended("refused", UNBUILT)),
  },
  prerequisite: () => UNBUILT,
  ownsResult: true,
  writesCode: false,
};

export { verify };
