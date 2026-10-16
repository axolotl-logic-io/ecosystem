// How a stage job holds a writer session to the config's contextLimits. A
// turn's context is the input, cache-read and cache-write tokens of one
// assistant message's usage (output tokens and earlier turns don't count). A
// writer session (an implementer, fixer, CI fixer or conflict resolver) past
// `soft` gets one steer to hand off, and past `hard` is stopped, its result a
// `handoff` reply that fits its launch's output schema. Any other session is
// neither steered nor stopped (Axlog, 2026-10-16). This module alone knows
// that rule, the limits' meaning, the steer's text and the stopped session's
// result.

import type { JsonSchema } from "../workflow/schemas.ts";
import type { LiveLaunch } from "./control.ts";
import { stopLaunch } from "./control.ts";
import type { SessionLaunch, SessionRaw, Usage } from "./raw-results.ts";
import { recordFacts } from "./raw-results.ts";
import { sessionRoleOf } from "./roles.ts";

// The context a writer session may pass once, to be steered (`soft`), and
// the one it may never pass (`hard`), in tokens.
interface ContextLimits {
  soft: number;
  hard: number;
}

// A writer session stopped at turn context `context`.
interface ContextStop {
  context: number;
}

// One session's watch, fed every record the session prints.
interface ContextWatch {
  // Reads one of pi's RPC records, steering or stopping the session.
  read: (record: unknown) => void;
  // The stop, once the writer passed `hard`; null until then.
  stopped: () => ContextStop | null;
}

// How a watched session ended: the result its records give, and its stop,
// null when the watch didn't stop it.
interface WatchedEnd {
  raw: SessionRaw;
  stop: ContextStop | null;
}

// The launch a stopped session ran for, with its reply's schema.
interface StoppedLaunch extends SessionLaunch {
  outputSchema: JsonSchema;
}

// The context one turn's usage shows.
function turnContext(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function steerText(context: number): string {
  return `Context is at ${context}. Stop now. Commit what builds, write the handoff file, and return \`handoff\`.`;
}

// The watch on a session the limits don't hold: it never steers or stops.
const UNWATCHED: ContextWatch = {
  read: (): void => undefined,
  stopped: (): null => null,
};

// Watches session `live` of installed agent `agent` against `limits`: steers
// a writer once, the first time a turn passes `soft`, and stops it, once,
// the first time a turn passes `hard`. Any other session goes unwatched.
function watchContext(
  limits: ContextLimits,
  agent: string,
  live: LiveLaunch,
): ContextWatch {
  if (sessionRoleOf(agent) !== "writer") {
    return UNWATCHED;
  }
  let steered = false;
  let stop: ContextStop | null = null;
  return {
    read: (record: unknown): void => {
      const { usage } = recordFacts(record);
      if (usage === null || stop !== null) {
        return;
      }
      const context = turnContext(usage);
      if (context > limits.hard) {
        stop = { context };
        stopLaunch(live).catch(() => null);
      } else if (context > limits.soft && !steered) {
        steered = true;
        live
          .send({ type: "steer", message: steerText(context) })
          .catch(() => null);
      }
    },
    stopped: (): ContextStop | null => stop,
  };
}

// A writer's handoff reply that fits `schema`: status `handoff`, `summary`,
// and every other string property empty and array property empty.
function handoffReply(
  schema: JsonSchema,
  summary: string,
): Record<string, unknown> {
  const reply = new Map<string, unknown>();
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (property.type === "string") {
      reply.set(name, "");
    } else if (property.type === "array") {
      reply.set(name, []);
    }
  }
  reply.set("status", "handoff");
  reply.set("summary", summary);
  return Object.fromEntries(reply);
}

// The result of writer `launch`'s session, stopped as `stop` says, having
// spent `usage`: its handoff.
function contextStopped(
  launch: StoppedLaunch,
  stop: ContextStop,
  usage: Usage,
): SessionRaw {
  const { key, agent } = launch;
  const results: SessionRaw["results"] = [{ usage }];
  const summary = `session hit the hard context limit (${stop.context})`;
  const structuredOutput = handoffReply(launch.outputSchema, summary);
  return { ok: true, structuredOutput, error: null, key, agent, results };
}

export type { ContextLimits, ContextStop, ContextWatch, WatchedEnd };
export { contextStopped, turnContext, watchContext };
