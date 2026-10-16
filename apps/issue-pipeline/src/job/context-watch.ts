// How a stage job holds a model session to the config's contextLimits. A
// turn's context is the input, cache-read and cache-write tokens of one
// assistant message's usage (output tokens and earlier turns don't count). A
// writer session past `soft` gets one steer to hand off; any session past
// `hard` is stopped. A stopped writer's result is a `handoff` reply that fits
// its launch's output schema, and any other session's is an error. This
// module alone knows that rule, the limits' meaning, the steer's text and
// the stopped session's result.

import type { JsonSchema } from "../workflow/schemas.ts";
import type { LiveLaunch } from "./control.ts";
import { stopLaunch } from "./control.ts";
import type { SessionLaunch, SessionRaw, Usage } from "./raw-results.ts";
import { recordFacts } from "./raw-results.ts";
import { sessionRoleOf } from "./roles.ts";

// The context a session may pass once, to be steered (`soft`), and the one
// it may never pass (`hard`), in tokens.
interface ContextLimits {
  soft: number;
  hard: number;
}

// How a session past `hard` ends: as a writer's handoff or as an error.
type StopResult = "handoff" | "error";

// A session stopped at turn context `context`, and how it ended.
interface ContextStop {
  context: number;
  result: StopResult;
}

// One session's watch, fed every record the session prints.
interface ContextWatch {
  // Reads one of pi's RPC records, steering or stopping the session.
  read: (record: unknown) => void;
  // The stop, once the session passed `hard`; null until then.
  stopped: () => ContextStop | null;
}

// The launch a stopped session ran for, with its reply's schema.
interface StoppedLaunch extends SessionLaunch {
  outputSchema: JsonSchema;
}

// The context one turn's usage shows.
function turnContext(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

// How a session of installed agent `agent` ends once stopped.
function stopResultOf(agent: string): StopResult {
  if (sessionRoleOf(agent) === "writer") {
    return "handoff";
  }
  return "error";
}

function steerText(context: number): string {
  return `Context is at ${context}. Stop now. Commit what builds, write the handoff file, and return \`handoff\`.`;
}

// Watches session `live` of installed agent `agent` against `limits`: steers
// a writer once, the first time a turn passes `soft`, and stops any session,
// once, the first time a turn passes `hard`.
function watchContext(
  limits: ContextLimits,
  agent: string,
  live: LiveLaunch,
): ContextWatch {
  const result = stopResultOf(agent);
  // Only a writer can hand off, so only a writer is steered.
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
        stop = { context, result };
        stopLaunch(live).catch(() => null);
      } else if (context > limits.soft && result === "handoff" && !steered) {
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

// The result of `launch`'s session, stopped as `stop` says, having spent
// `usage`: a writer's handoff, or any other session's error.
function contextStopped(
  launch: StoppedLaunch,
  stop: ContextStop,
  usage: Usage,
): SessionRaw {
  const { key, agent } = launch;
  const results: SessionRaw["results"] = [{ usage }];
  const { context, result } = stop;
  switch (result) {
    case "handoff": {
      const summary = `session hit the hard context limit (${context})`;
      const structuredOutput = handoffReply(launch.outputSchema, summary);
      return { ok: true, structuredOutput, error: null, key, agent, results };
    }
    case "error": {
      const error = `context passed the hard limit (${context})`;
      return { ok: false, structuredOutput: null, error, key, agent, results };
    }
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

export type { ContextLimits, ContextStop, ContextWatch, StopResult };
export { contextStopped, turnContext, watchContext };
