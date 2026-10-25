// How a run started for an assignment pauses (#119, `assignment-permission`).
// The role runs as usual; a throw while the work item is paused is the
// pause, not a failure or a stop. Before the job applies the role's end it
// reads the grant again, fresh. A paused run applies no end and writes
// nothing more: it ends `wait`, `paused: …`, with its last saved state as its
// checkpoint, and teardown keeps its local work as on any exit. A run that
// isn't for an assignment never pauses.

import type { IssueState } from "../state.ts";
import type { Role, RoleContext, RoleEnd } from "./role-context.ts";
import { thrownEnd } from "./role-end.ts";

// Why the run's work item is paused, read fresh, or null; null for a run
// that isn't for an assignment.
type PauseCheck = (() => string | null) | null;
interface Paused {
  kind: "paused";
  reason: string;
}

// The role's end, a pause when it threw while the work item is paused, or
// thrownEnd's end of any other throw.
async function roleOrPause(
  role: Role,
  ctx: RoleContext,
  job: { paused: PauseCheck; claimed: { last: IssueState } },
): Promise<RoleEnd | Paused> {
  try {
    return await role(ctx);
  } catch (error: unknown) {
    const reason = job.paused?.() ?? null;
    if (reason !== null) {
      return { kind: "paused", reason };
    }
    return thrownEnd(error, job.claimed.last);
  }
}

// `end`, or a pause when the work item is paused now, on a fresh read.
function pausedBefore(
  end: RoleEnd | Paused,
  paused: PauseCheck,
): RoleEnd | Paused {
  if (end.kind === "paused") {
    return end;
  }
  const reason = paused?.() ?? null;
  if (reason !== null) {
    return { kind: "paused", reason };
  }
  return end;
}

export type { PauseCheck, Paused };
export { pausedBefore, roleOrPause };
