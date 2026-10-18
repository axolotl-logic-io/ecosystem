// The order a job starts the sessions of one sessions effect in
// (src/roles/sessions.ts, #421): of the sessions on one model, the first
// starts at once and each later one once the one before it has printed its
// first `message_end` record, or has ended without one, so it reads their
// shared prefix from the provider's prompt cache. Sessions on different
// models start together. Each wait is for an event, never a clock.

import { isRecord } from "../workflow/stages/reply-guards.ts";
import type { LaunchHooks } from "./launch.ts";

// Runs each of `sessions` through `run` in cache order, and gives their
// results in `sessions`' order. `run` calls `turned` when its session
// prints its first message_end (onFirstTurn does), and its settling counts
// as the turn too.
function inCacheOrder<S extends { model: string }, R>(
  sessions: readonly S[],
  run: (session: S, turned: () => void) => Promise<R>,
): Promise<R[]> {
  const turns = new Map<string, Promise<void>>();
  return Promise.all(
    sessions.map(async (session: S): Promise<R> => {
      const before = turns.get(session.model);
      const turn = Promise.withResolvers<void>();
      turns.set(session.model, turn.promise);
      if (before !== undefined) {
        await before;
      }
      try {
        return await run(session, turn.resolve);
      } finally {
        turn.resolve();
      }
    }),
  );
}

function isMessageEnd(record: unknown): boolean {
  if (!isRecord(record)) {
    return false;
  }
  const { type } = record;
  return type === "message_end";
}

// `hooks`, also calling `turned` on every message_end record a session
// prints.
function onFirstTurn(hooks: LaunchHooks, turned: () => void): LaunchHooks {
  return {
    ...hooks,
    record: (key: string, record: unknown): void => {
      hooks.record(key, record);
      if (isMessageEnd(record)) {
        turned();
      }
    },
  };
}

export { inCacheOrder, onFirstTurn };
