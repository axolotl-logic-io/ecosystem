// How a stage job holds a writer or spec writer session to the config's
// contextLimits. A turn's context is the input, cache-read and cache-write
// tokens of one assistant message's usage (output tokens and earlier turns
// don't count). A session held to the limits (an implementer, fixer, CI
// fixer or conflict resolver, or the spec writer, #335) past `soft` gets one
// steer to wrap up and write its handoff as the next round's summary
// (wrap-up-at-175k, Axlog, 2026-10-17), and past `hard` is stopped, its
// result a `handoff` reply that fits its launch's output schema (the handoff
// file the job then writes for it is stop-handoff.ts's). Any other session
// is neither steered nor stopped (Axlog, 2026-10-16). This module alone
// knows that rule, the limits' meaning, the steer's text and the stopped
// session's result.

import type { JsonSchema } from "../workflow/schemas.ts";
import type { LiveLaunch } from "./control.ts";
import { stopLaunch } from "./control.ts";
import type { SessionLaunch, SessionRaw, Usage } from "./raw-results.ts";
import { recordFacts } from "./raw-results.ts";
import { heldToLimits, SPEC_AGENT } from "./roles.ts";

// The context a writer session may pass once, to be steered (`soft`), and
// the one it may never pass (`hard`), in tokens.
interface ContextLimits {
  soft: number;
  hard: number;
}

// The limits a writer session is held to, and the handoff file the steer
// tells it to write.
interface WriterHold {
  limits: ContextLimits;
  handoffFile: string;
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
  // A writer's last assistant text, for the handoff the job writes once it
  // stopped it; null until it gives one, and always for any other session.
  lastText: () => string | null;
}

// How a watched session ended: the result its records give, its stop, null
// when the watch didn't stop it, and its last assistant text, null when it
// gave none.
interface WatchedEnd {
  raw: SessionRaw;
  stop: ContextStop | null;
  lastText: string | null;
}

// The launch a stopped session ran for, with its reply's schema.
interface StoppedLaunch extends SessionLaunch {
  outputSchema: JsonSchema;
}

// The context one turn's usage shows.
function turnContext(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

// What the steer tells a session to keep of its work, and how to reply.
interface WrapUp {
  keep: string;
  reply: string;
}

// A writer makes its work build and commits it.
const WRITER_WRAP_UP: WrapUp = {
  keep: "Make it build, and commit it.",
  reply: "Then return status `handoff`.",
};

// The spec writer commits its tests, stubs and spec draft; its reply's
// other fields are ignored once its status is `handoff`.
const SPEC_WRAP_UP: WrapUp = {
  keep: "Commit the tests, stubs and spec draft you have with `pipeline_commit`.",
  reply:
    "Then return status `handoff` with a `summary`; the reply's other fields are ignored.",
};

function wrapUpOf(agent: string): WrapUp {
  if (agent === SPEC_AGENT) {
    return SPEC_WRAP_UP;
  }
  return WRITER_WRAP_UP;
}

// The steer a session of `agent` gets once its turn context `context` passes
// `soft`: finish the edit it is in, keep its work, and write the handoff as
// the next round's only summary.
function steerText(hold: WriterHold, context: number, agent: string): string {
  const { limits, handoffFile } = hold;
  const { keep, reply } = wrapUpOf(agent);
  return `Context is at ${context} tokens, past the soft limit of ${limits.soft}. Wrap up now: finish the edit you are in the middle of, and don't start new ones. ${keep} Then write ${handoffFile} as a summary for the next round: what is done; what is left, in order; the decisions you made and why; the traps and dead ends you found; and the branch state, with the last commit and whether the checks pass. The next session starts from this summary alone. ${reply} At ${limits.hard} tokens this session is stopped.`;
}

// The watch on a session the limits don't hold: it never steers or stops.
const UNWATCHED: ContextWatch = {
  read: (): void => undefined,
  stopped: (): null => null,
  lastText: (): null => null,
};

// Watches session `live` of installed agent `agent` against `hold.limits`:
// steers a session held to the limits once, the first time a turn passes
// `soft`, and stops it, once, the first time a turn passes `hard`. Any other
// session goes unwatched.
function watchContext(
  hold: WriterHold,
  agent: string,
  live: LiveLaunch,
): ContextWatch {
  if (!heldToLimits(agent)) {
    return UNWATCHED;
  }
  const { limits } = hold;
  let steered = false;
  let stop: ContextStop | null = null;
  let lastText: string | null = null;
  return {
    read: (record: unknown): void => {
      const { usage, text } = recordFacts(record);
      lastText = text ?? lastText;
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
          .send({ type: "steer", message: steerText(hold, context, agent) })
          .catch(() => null);
      }
    },
    stopped: (): ContextStop | null => stop,
    lastText: (): string | null => lastText,
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

export type {
  ContextLimits,
  ContextStop,
  ContextWatch,
  WatchedEnd,
  WriterHold,
};
export { contextStopped, turnContext, watchContext };
