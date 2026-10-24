// Implementation's place in the chain (#118; `requirements-bindings`):
// Hardening is ready only once a passed Implementation result is current for
// today's requirements. Implementation binds the requirements digest, not a
// revision, so its result stays current while the requirements do. Edited
// requirements stale it, and the work goes back to Implementation (#172). A
// moved target doesn't: that needs Sync and fresh Hardening
// (`sync-is-a-task`), so currency compares the target's branch, not its
// commit. The recorded binding still names the exact commit, and a new
// commit starts a new budget.

import type {
  Binding,
  Result,
  Row,
  TaskStatus,
} from "../task-result-records.ts";
import { isResult, requirementsDigest } from "../task-result-records.ts";
import { statusIn } from "../task-results.ts";
import type { RevisionBinding } from "./task-gate.ts";

type RequirementsBinding = Extract<Binding, { requirements: string }>;

// The Implementation binding for `base`'s work item, requirements and target.
function implementationBinding(base: RevisionBinding): RequirementsBinding {
  return {
    repo: base.repo,
    workItem: base.workItem,
    task: "Implementation",
    requirements: requirementsDigest(base.revision.inputs),
    target: base.target,
  };
}

// The latest passed Implementation result for exactly these requirements on
// the target's branch, under any target commit.
function currentImplementation(
  rows: readonly Row[],
  binding: RequirementsBinding,
): Row<Result> | undefined {
  return rows
    .filter(isResult)
    .filter(
      (row) =>
        row.verdict === "passed" &&
        row.binding.task === "Implementation" &&
        "requirements" in row.binding &&
        row.binding.requirements === binding.requirements &&
        row.binding.target.branch === binding.target.branch,
    )
    .at(-1);
}

// The revision the current Implementation result produced, or null when none
// is current.
function implementedRevision(
  rows: readonly Row[],
  base: RevisionBinding,
): string | null {
  const current = currentImplementation(rows, implementationBinding(base));
  return current?.receipt.produced?.code ?? null;
}

// Implementation as the next ready task, a hold, or null once its result is
// current and the chain goes on.
function implementationNext(
  rows: readonly Row[],
  base: RevisionBinding,
):
  | {
      next: {
        task: "Implementation";
        binding: Binding;
        status: TaskStatus["status"];
      };
    }
  | { hold: string }
  | null {
  const binding = implementationBinding(base);
  if (currentImplementation(rows, binding) !== undefined) {
    return null;
  }
  const { status } = statusIn(rows, binding);
  if (status === "exhausted") {
    return {
      hold: "Implementation has used its attempts for these requirements and target",
    };
  }
  return { next: { task: "Implementation", binding, status } };
}

export { implementationBinding, implementationNext, implementedRevision };
