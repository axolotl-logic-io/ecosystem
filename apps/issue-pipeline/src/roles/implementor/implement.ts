// The implementor's `implement` entry (the wiki's Pipeline-Roles-Implementor,
// "Entry `implement`"): skip work already done, set the checkout up, run
// the implementer with a continuation after each handoff up to
// maxContinuations, and push. Every `blocked` stops the issue; no state
// touches the PR. Pure.

import { z } from "zod";
import type { Guard } from "../machine.ts";
import type { ImplData, ImplState } from "./locate.ts";
import { implReadingOf } from "./reply.ts";
import type { ImplStates } from "./states.ts";
import { check } from "./states.ts";
import { implementerSession } from "./task.ts";

// What the `flows` check answers with after the push.
const PUSHED = z.looseObject({
  headSha: z.string(),
  flows: z.object({ code: z.boolean(), wiki: z.boolean() }),
});

const CONTINUATIONS: Guard<ImplState, ImplData> = {
  field: "continuations",
  limit: "maxContinuations",
  over: "out-of-room",
};

// Whether the wiki is the whole change: it has no tests, and the spec
// writer said so.
function wikiOnly(data: ImplData): boolean {
  return data.wikiOnly === true && typeof data.noTestsReason === "string";
}

// The session's reply, as the role reads it.
function read(data: ImplData, reply: unknown): ImplData {
  return { ...data, reply: implReadingOf(reply) };
}

// The pushed head and the issue's flows, as the push reported them.
function pushed(data: ImplData, reply: unknown): ImplData {
  const parsed = PUSHED.safeParse(reply);
  if (!parsed.success) {
    return data;
  }
  const { headSha, flows } = parsed.data;
  return { ...data, headSha, flows };
}

function implemented(data: ImplData, reply: unknown): ImplData {
  return { ...pushed(data, reply), implemented: true };
}

const IMPLEMENT_STATES: ImplStates<
  "implement-work?" | "setup" | "implementer" | "implementer-reply" | "flows"
> = {
  "implement-work?": check(
    "implement-work?",
    (data: ImplData) => ({
      specTestsSha: data.specTestsSha ?? null,
      wikiOnly: wikiOnly(data),
    }),
    {
      none: { to: "wiki-only" },
      built: { to: "flows" },
      work: { to: "setup" },
    },
  ),
  setup: check("setup", () => ({}), { ok: { to: "implementer" } }),
  implementer: {
    kind: "session",
    effect: implementerSession,
    on: { replied: { to: "implementer-reply", apply: read } },
  },
  "implementer-reply": check(
    "implementer-reply",
    (data: ImplData) => ({ reading: data.reply }),
    {
      done: { to: "flows" },
      handoff: { to: "implementer", count: CONTINUATIONS },
      blocked: { to: "blocked" },
      bad: { to: "bad-reply" },
    },
  ),
  flows: check("flows", () => ({}), {
    code: { to: "implemented", apply: implemented },
    none: { to: "changed-nothing", apply: pushed },
  }),
};

export { IMPLEMENT_STATES };
