// Shared model session types.
type AccessProfile = "reader" | "writer" | "lander";
interface SessionSpec {
  phase?: "hardening" | "security-review" | "fix";
}
type SessionResult =
  | { ok: true; reply: unknown }
  | { ok: false; transient: boolean; error: string };

export type { AccessProfile, SessionResult, SessionSpec };
