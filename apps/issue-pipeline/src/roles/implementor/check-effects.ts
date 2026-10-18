// The ops the `checks` entry's checks (checks-ops.ts, ci-fix-checks.ts) run
// through the job's effects, comments on the PR included. They answer
// through outcome.ts.

import type { OpEffect, Outcome } from "../../job/run-step.ts";
import type { Entry } from "../../job/runner.ts";
import type { Signature } from "../../workflow/signing.ts";
import type { JobEffects } from "../registry.ts";

type Payload = OpEffect["payload"];

// How many characters of a head a comment names.
const SHORT_SHA = 12;

// What a check runs its ops with: the issue, who signs its comments, and
// the job's effects.
interface Ops {
  number: number;
  jobId: string;
  models: Entry["context"]["models"];
  effects: JobEffects;
}

// Runs op `op` on the issue with `payload`, for up to `minutes` when given.
function opOf(
  ops: Ops,
  op: string,
  payload: Payload,
  minutes?: number,
): Promise<Outcome> {
  const effect: OpEffect = {
    kind: "op",
    op,
    payload: { number: ops.number, ...payload },
  };
  if (minutes === undefined) {
    return ops.effects.op(effect);
  }
  return ops.effects.op({ ...effect, minutes });
}

// Posts `comments`, each with its author and body, on the PR (the issue
// without one).
function posted(
  ops: Ops,
  pr: number | null,
  comments: readonly { by: Signature; body: string }[],
): Promise<Outcome> {
  const number = pr ?? ops.number;
  const listed = comments.map((comment) => ({ number, ...comment }));
  return opOf(ops, "post", { comments: listed });
}

export type { Ops };
export { opOf, posted, SHORT_SHA };
