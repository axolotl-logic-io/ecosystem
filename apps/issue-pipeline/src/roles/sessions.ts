// Model sessions that run together, as one effect of a role machine (#421;
// the wiki's Pipeline-Roles-Shared page, "Role machines", and
// Pipeline-Roles-Reviewer, "Sessions"). Of the sessions on one model, the
// first starts at once and each later one once the first has printed its
// first `message_end` event, or has ended without one, so it reads their
// shared prefix from the prompt cache; sessions on different models start
// together. The runner (src/job/runner.ts) carries the effect out, and the
// job's launcher (src/job/role-launcher.ts) keeps the order. They sit beside
// machine.ts's `Effect`, which holds them.

import { z } from "zod";
import type { Effect, SessionEffect } from "./machine.ts";

interface SessionsEffect {
  kind: "sessions";
  sessions: readonly SessionEffect[];
}

// What a sessions effect replies, as its `replied` result: each session's
// outcome, in the effect's order. A failed session drops no other's reply.
type SessionsReply = readonly {
  name: string;
  outcome: { ok: true; reply: unknown } | { ok: false; error: string };
}[];

const SESSIONS_REPLY = z.array(
  z.object({
    name: z.string(),
    outcome: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), reply: z.unknown() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  }),
);

// A sessions effect's reply as a role reads it back, or null when `value`
// isn't one.
function sessionsReplyOf(value: unknown): SessionsReply | null {
  const parsed = SESSIONS_REPLY.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

// Whether `effect` runs a model: a session state's effect, and only its.
function runsModel(effect: Effect): boolean {
  return effect.kind === "session" || effect.kind === "sessions";
}

export type { SessionsEffect, SessionsReply };
export { runsModel, sessionsReplyOf };
