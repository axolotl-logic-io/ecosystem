import type { SessionProfile } from "../config-schema.ts";

// How a session ended as its launch saw it: its result.
type SessionEnded = "ok" | "failed";

// The steers the job sent a session through the steer socket, the
// watchdog's or one sent by hand with `--steer`.
interface Steers {
  socket: number;
}

// What the launch knows of a session as it ends: its session profile, agent,
// model and end, its steers, the code checkout's head as it ended, and for a session
// that can't commit, the head it ran on, which it reviewed (null for a
// writer, and either is null with no head to read).
interface SessionEnd {
  // Historical observation wire key, retained for existing readers.
  role: SessionProfile;
  agent: string;
  model: string;
  ended: SessionEnded;
  steers: Steers;
  headSha: string | null;
  reviewedSha: string | null;
}

export type { SessionEnd, Steers };
