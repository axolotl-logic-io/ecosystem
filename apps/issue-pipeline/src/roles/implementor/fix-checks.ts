// The `fix` entry's script checks (#418), for one run of the implementor's
// machine: whether findings are open, the fixer's reply with its comment,
// the push and what its flows mean for the PR, whether a lens has findings
// to re-review, and the findings' update with the re-reviewers' comments.
// The table works out every answer but the push's (fix.ts); these post the
// comments it built through the `post` op and answer with its result.

import { z } from "zod";
import type { CheckEffect, Outcome } from "../../job/run-step.ts";
import { prFlowAction } from "../../workflow/flows.ts";
import type { Checks, JobEffects } from "../registry.ts";
import { answer, guarded, PUSHED } from "./outcome.ts";

type Payload = CheckEffect["payload"];
// Pushes the issue's branch, answering with the pushed head and the flows.
type Push = () => Promise<Outcome>;

const OPEN = z.looseObject({ open: z.number() });
const COMMENTS = z.looseObject({ comments: z.array(z.unknown()) });
const FIXER_REPLY = z.looseObject({
  status: z.enum(["done", "handoff"]).nullable(),
  disputed: z.boolean(),
});
const UPDATE = z.looseObject({
  result: z.enum(["resolved", "open", "reintroduced", "bad"]),
  update: z.unknown(),
});
const FLOWS = z.looseObject({ prClosed: z.boolean() });
// `open` when the payload counts open findings, else `none`.
function openOrNone(payload: Payload): Outcome {
  if (OPEN.parse(payload).open > 0) {
    return answer("open");
  }
  return answer("none");
}

// Posts the payload's signed comments, if any, then answers `then`.
async function posted(
  effects: JobEffects,
  payload: Payload,
  then: Outcome,
): Promise<Outcome> {
  const { comments } = COMMENTS.parse(payload);
  if (comments.length === 0) {
    return then;
  }
  const done = await effects.op({
    kind: "op",
    op: "post",
    payload: { comments },
  });
  if (!done.ok) {
    return done;
  }
  return then;
}

// `bad` for a reply that didn't read, `acceptance` when the fixer disputed
// an acceptance finding, and otherwise the reply's status.
function fixerAnswer(payload: Payload): Outcome {
  const { status, disputed } = FIXER_REPLY.parse(payload);
  if (status === null) {
    return answer("bad");
  }
  if (disputed) {
    return answer("acceptance");
  }
  return answer(status);
}

// Pushes the fix, and answers what its flows mean for the PR: `go` on,
// `reopen` a closed PR, or `none` for a fix that left no code change.
async function fixFlows(push: Push, payload: Payload): Promise<Outcome> {
  const done = await push();
  if (!done.ok) {
    return done;
  }
  const reply = PUSHED.parse(done.reply);
  const action = prFlowAction(reply.flows, FLOWS.parse(payload).prClosed);
  switch (action) {
    case "go":
    case "reopen":
      return answer(action, reply);
    case "stop":
    case "close":
      return answer("none", reply);
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}

// The `fix` entry's checks, with ops through `effects` and the push the
// `implement` entry's flows check makes.
function fixChecks(effects: JobEffects, push: Push): Checks {
  return {
    "fix-work?": (payload: Payload) => guarded(() => openOrNone(payload)),
    "fixer-reply": (payload: Payload) =>
      guarded(() => posted(effects, payload, fixerAnswer(payload))),
    "fix-flows": (payload: Payload) => guarded(() => fixFlows(push, payload)),
    "rereview?": (payload: Payload) => guarded(() => openOrNone(payload)),
    "update-findings": (payload: Payload) =>
      guarded(() => {
        const { result, update } = UPDATE.parse(payload);
        return posted(effects, payload, answer(result, update));
      }),
  };
}

export { fixChecks };
