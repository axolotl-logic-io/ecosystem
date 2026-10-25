// What keeps a closed issue's worktree from the cleanup op (#170), apart
// from its own unsaved work: an issue-execution request or owner that no
// release or cancel ended, read from the authenticated coordination records,
// and any registered consumer of the issue's lane slot, another surviving
// checkout or a pending setup (capacity-by-resource). Neither the issue
// closing nor an empty patch list frees what a consumer still needs. A
// record or store that can't be read throws, and the cleanup op keeps the
// worktree with that reason.

import type { IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { recordsOf, scopeOf } from "../coordination-records.ts";
import { registeredConsumers } from "../lane-slots.ts";

// Why issue `n`'s execution still holds it, from its listed `comments`, or
// null when every request on its branch was released or cancelled.
function heldExecution(
  cfg: Config,
  n: number,
  comments: readonly IssueComment[],
): string | null {
  const scope = scopeOf(
    {
      issue: n,
      branch: paths.branch(cfg, n),
      repo: cfg.repo,
      base: cfg.baseBranch,
    },
    "issue",
  );
  const rows = recordsOf(cfg, comments, scope);
  const ended = new Set(
    rows.flatMap((row) => {
      if (row.kind === "release" || row.kind === "cancel") {
        return [row.request];
      }
      return [];
    }),
  );
  const lanes = rows.flatMap((row) => {
    if (row.kind === "request" && !ended.has(row.id)) {
      return [row.binding.lane];
    }
    return [];
  });
  if (lanes.length > 0) {
    return `issue execution is held by lane ${lanes.join(", ")}`;
  }
  return null;
}

// Why issue `n`'s lane slot still has a consumer besides its worktree, or
// null.
function slotConsumed(cfg: Config, n: number): string | null {
  const consumers = registeredConsumers(cfg, n, paths.worktree(cfg, n));
  if (consumers.length > 0) {
    return `the lane slot still has registered consumers: ${consumers.join(", ")}`;
  }
  return null;
}

export { heldExecution, slotConsumed };
