import { childEnvironment } from "./child-env.ts";
import { COMMIT_SCOPE_ENV } from "./job/pipeline-commit.ts";

// Hosts supply additional credential names, never a credential map to a task.
// A committing session receives its own bound commit scope after filtering.
function modelEnvironment(
  from: Readonly<Record<string, string | undefined>>,
  hiddenNames: readonly string[],
): Record<string, string> {
  const hidden = new Set([COMMIT_SCOPE_ENV, ...hiddenNames]);
  return Object.fromEntries(
    Object.entries(childEnvironment(from)).filter(
      ([name]) => !hidden.has(name),
    ),
  );
}

export { modelEnvironment };
