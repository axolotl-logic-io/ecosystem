// How the role runner (src/job/runner.ts) runs a state's model sessions: one
// session, or a sessions effect's several (src/roles/sessions.ts), each with
// its usage entry appended. A sessions effect replies every session's
// outcome, in the effect's order, so a failed session drops no other's
// reply. A transient or network failure of any of them, such as the
// provider's rate limit, fails the whole effect instead, and the runner
// holds the run as it holds a single session's failure.

import type { SessionEffect } from "../roles/machine.ts";
import type { SessionsEffect, SessionsReply } from "../roles/sessions.ts";
import { isNetworkError } from "../workflow/stages/network.ts";
import { isTransientSessionError } from "../workflow/stages/rate-limit.ts";
import type { Effects, Outcome, SessionRun } from "./run-step.ts";
import type { RunUsage, SessionEntry, UsageEntry } from "./run-usage.ts";

// What a run's sessions are recorded against: its effects, its usage
// bookkeeping and the stage it is at.
interface SessionScope {
  effects: Effects;
  usage: RunUsage;
  stage: string;
}

type SessionReply = SessionsReply[number];

// The usage entry of `effect`, run at `state` as `ran` says.
function entryOf(
  scope: SessionScope,
  state: string,
  effect: SessionEffect,
  ran: SessionRun,
): SessionEntry {
  const { effects, stage } = scope;
  const { outcome, launch, key } = ran;
  const signalled = effects.stopping() !== null;
  const at = effects.clock();
  const finished = {
    at,
    key,
    stage,
    state,
    effect,
    launch,
    outcome,
    signalled,
  };
  return scope.usage.session(finished);
}

// Appends `entries` in turn: the usage op edits one comment, so two at
// once could race.
async function appendInTurn(
  effects: Effects,
  entries: readonly UsageEntry[],
): Promise<void> {
  const [first, ...rest] = entries;
  if (first === undefined) {
    return;
  }
  await effects.usage(first);
  await appendInTurn(effects, rest);
}

// Runs session `effect` at `state` and appends its usage entry.
async function runSession(
  scope: SessionScope,
  state: string,
  effect: SessionEffect,
): Promise<Outcome> {
  const ran = await scope.effects.session(effect);
  await scope.effects.usage(entryOf(scope, state, effect, ran));
  return ran.outcome;
}

// Whether a session's failure holds the run rather than ending the session.
function holds(error: string): boolean {
  return isTransientSessionError(error) || isNetworkError(error);
}

function replyOf(name: string, ran: SessionRun | undefined): SessionReply {
  if (ran === undefined) {
    return { name, outcome: { ok: false, error: "the session didn't run" } };
  }
  const { outcome } = ran;
  if (outcome.ok) {
    return { name, outcome: { ok: true, reply: outcome.reply } };
  }
  return { name, outcome: { ok: false, error: outcome.error } };
}

// The first failure among `reply` that holds the run, or null.
function heldBy(reply: readonly SessionReply[]): string | null {
  for (const { outcome } of reply) {
    if (!outcome.ok && holds(outcome.error)) {
      return outcome.error;
    }
  }
  return null;
}

// Runs the sessions of `effect` at `state`, appending each one's usage
// entry, and replies each one's outcome, unless a failure holds the run.
async function runSessions(
  scope: SessionScope,
  state: string,
  effect: SessionsEffect,
): Promise<Outcome> {
  const runs = await scope.effects.sessions(effect);
  const entries: UsageEntry[] = [];
  const reply = effect.sessions.map(
    (session: SessionEffect, index: number): SessionReply => {
      const ran = runs[index];
      if (ran !== undefined) {
        entries.push(entryOf(scope, state, session, ran));
      }
      return replyOf(session.name, ran);
    },
  );
  await appendInTurn(scope.effects, entries);
  const held = heldBy(reply);
  if (held !== null) {
    return { ok: false, error: held };
  }
  return { ok: true, name: "replied", reply };
}

export type { SessionScope };
export { runSession, runSessions };
