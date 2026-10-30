// Shared model session types.
type SessionPhase = "hardening" | "security-review" | "fix";
type SessionResult =
  | { ok: true; reply: unknown }
  | { ok: false; transient: boolean; error: string };

export type { SessionPhase, SessionResult };
