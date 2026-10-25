// What each task module owns beside its domain definition: the
// prerequisites a new attempt needs on fresh evidence, judged in the ops
// child that records it; anything the task must hold before that record,
// such as Land's integration turn; and which verdicts only its own effect
// op may record.

import type { Config } from "../config.ts";
import type {
  ActionEnd,
  Binding,
  RevisionBinding,
  TaskDefinition,
} from "../domain.ts";
import { isRevisionBinding, sameBinding } from "../domain.ts";
import { readWriteAuthority } from "../write-authority.ts";
import { currentBinding } from "./chain.ts";
import type { TaskEvidence } from "./view.ts";

type Admission =
  | { state: "admitted" }
  | { state: "waiting" | "held"; reason: string };

interface TaskModule {
  definition: TaskDefinition;
  // Why a new attempt of `binding` may not be recorded now, or null.
  prerequisite: (
    cfg: Config,
    evidence: TaskEvidence,
    binding: Binding,
  ) => string | null;
  // What the task must hold before its attempt is recorded.
  admit?: (cfg: Config, number: number) => Admission;
  // Its effect op records its determined verdicts; the generic result op
  // records only an unknown end of its runs.
  ownsResult: boolean;
  // Its passed result may name produced code: the item branch's head.
  writesCode: boolean;
}

// Why `binding` isn't the current revision binding of its task: exactly
// revision R and target T as read now.
function notCurrent(evidence: TaskEvidence, binding: Binding): string | null {
  if (!isRevisionBinding(binding)) {
    return "the binding is not a revision binding";
  }
  const current = currentBinding(evidence.view, binding.task);
  if (current === null || !sameBinding(current, binding)) {
    return `the binding is not ${binding.task}'s current revision and target`;
  }
  return null;
}

// Why the item's code can't be written now, or null.
function notWritable(cfg: Config, number: number): string | null {
  const authority = readWriteAuthority(cfg, number);
  if (!authority.codeWritable) {
    return `code is not writable: ${authority.fence ?? "fenced"}`;
  }
  return null;
}

function revisionOf(binding: Binding): RevisionBinding {
  if (!isRevisionBinding(binding)) {
    throw new TypeError("a revision task needs a revision binding");
  }
  return binding;
}

function ended(
  verdict: ActionEnd["verdict"],
  reason: string,
  produced?: string,
): ActionEnd {
  const outcome = {
    passed: "succeeded",
    failed: "failed",
    refused: "refused",
    unknown: "unknown",
  } as const;
  const end: ActionEnd = {
    state: "ended",
    outcome: outcome[verdict],
    reason,
    verdict,
  };
  if (produced !== undefined) {
    return { ...end, produced: { code: produced } };
  }
  return end;
}

export type { Admission, TaskModule };
export { ended, notCurrent, notWritable, revisionOf };
