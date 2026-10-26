// Session phase labels retained in launch observations and historical logs.
// The canonical session contract belongs to domain.ts, not a stage role.
import type { SessionSpec } from "../domain.ts";

type SessionPhase = NonNullable<SessionSpec["phase"]>;
const SESSION_PHASES: readonly SessionPhase[] = [
  "hardening",
  "security-review",
  "fix",
];

export type { SessionPhase };
export { SESSION_PHASES };
