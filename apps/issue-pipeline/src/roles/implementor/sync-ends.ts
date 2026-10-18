// The ends of the implementor's start sync and its `sync` entry (#419; the
// wiki's Pipeline-Roles-Implementor, "Start sync" and "Sync"): the `sync`
// entry saved at checks, and the stops and releases of a rebase that didn't
// finish. Conflicts never stop the issue (`conflicts-never-stop`) except
// past maxConflictFixes; a resolver's cannot-fix releases it at its stage
// for the next job. Pure.

import { outOfRoomReason } from "../../workflow/stages/continuation.ts";
import type { End } from "../machine.ts";
import type { EndSpec } from "./ends.ts";
import { end, stopped } from "./ends.ts";
import type { ImplData } from "./locate.ts";

// The stop codes (src/stops.ts).
const CONFLICT = "conflict";
const SYNC_LIMIT = "sync-limit";
const TOO_LARGE = "too-large";
const ERROR = "error";

type SyncEnd =
  | "synced"
  | "too-many-syncs"
  | "rejected"
  | "cannot-fix"
  | "conflicts"
  | "resolver-out-of-room"
  | "resolver-failed";

// The conflicting files, one to a line, and the resolver's last summary.
function detailOf(data: ImplData): string {
  const files = (data.conflict?.files ?? []).map((file) => `- ${file}`);
  const summary = data.resolution?.summary ?? "";
  return [...files, "", summary].join("\n").trim();
}

// A rejected resolution releases the issue for the next job, and stops it
// on the last attempt.
function rejected(data: ImplData): End {
  if (data.conflictFixes < data.maxConflictFixes) {
    return { kind: "released" };
  }
  return stopped(data, CONFLICT, {
    reason: "the conflict resolution was rejected",
    detail: `${detailOf(data)}\n\n${data.rejection ?? ""}`.trim(),
  });
}

function tooManySyncs(data: ImplData): End {
  const { baseBranch } = data.settings.cfg;
  return stopped(data, SYNC_LIMIT, {
    reason: `${baseBranch} kept moving; rebased ${data.maxSyncs} times without merging`,
    detail: "",
  });
}

const SYNC_END_STATES: Readonly<Record<SyncEnd, EndSpec>> = {
  synced: end(() => ({ kind: "saved", stage: "checks" })),
  "too-many-syncs": end(tooManySyncs),
  rejected: end(rejected),
  "cannot-fix": end(() => ({ kind: "released" })),
  conflicts: end((data: ImplData) =>
    stopped(data, CONFLICT, {
      reason: `the rebase still conflicts after ${data.maxConflictFixes} conflict resolutions`,
      detail: detailOf(data),
    }),
  ),
  "resolver-out-of-room": end((data: ImplData) =>
    stopped(data, TOO_LARGE, {
      reason: outOfRoomReason("conflict resolver", data.maxContinuations),
      detail: `Latest handoff: ${data.settings.paths.handoffFile}\n\n${detailOf(data)}`,
    }),
  ),
  "resolver-failed": end((data: ImplData) =>
    stopped(data, ERROR, {
      reason:
        "the conflict-resolver session failed or its reply could not be read",
      detail: detailOf(data),
    }),
  ),
};

export type { SyncEnd };
export { SYNC_END_STATES };
