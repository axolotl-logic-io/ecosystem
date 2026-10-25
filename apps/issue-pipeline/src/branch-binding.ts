// The binding between an issue and the one branch its work is on. The
// first claim binds the branch the caller assigned (config.ts's
// paths.branch) into the issue's state; after that, an op that pushes,
// readies, lands or deletes refuses any other assignment before anything
// moves, so a resume can never strand or overwrite the issue's work on its
// own branch. A state saved before assignments (branch null) is bound to
// the legacy agent/issue-<n> its work is on.

import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { OpsError } from "./ops-error.ts";
import type { IssueState } from "./state.ts";

// The branch issue `n` is assigned (paths.branch), which `state` must be
// bound to, or which a first claim (`state` null: nothing saved) binds.
// Throws when `state` is bound to another branch.
function assignedBranch(
  cfg: Config,
  n: number,
  state: Pick<IssueState, "branch"> | null,
): string {
  const assigned = paths.branch(cfg, n);
  if (state === null) {
    return assigned;
  }
  const bound = state.branch ?? paths.legacyBranch(n);
  if (bound !== assigned) {
    throw new OpsError(
      `#${n}'s work is on ${bound}, not the assigned ${assigned}; assign ${bound} to resume it`,
    );
  }
  return assigned;
}

export { assignedBranch };
