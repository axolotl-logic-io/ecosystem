// How the reviewer's script checks answer and post (checks.ts for the
// `review` entry, accept-checks.ts for `accept`): an outcome named by one of
// the machine's results, a check whose throw becomes its failure, and the
// signed comments a check posts through the `post` op.

import type { Outcome } from "../../job/run-step.ts";
import type { Signature } from "../../workflow/signing.ts";
import type { JobEffects } from "../registry.ts";

// The reader agent every reviewer session runs as, which signs its comments.
const READER = "issue-pipeline-reader";

// A signed comment on issue or PR `number`, updated in place by `key`.
interface Comment {
  number: number;
  by: Signature;
  body: string;
  key?: string;
}

function answer(name: string, reply: unknown = null): Outcome {
  return { ok: true, name, reply };
}

function ok(): Promise<Outcome> {
  return Promise.resolve(answer("ok"));
}

// `act`'s outcome, or its throw as a failure.
async function guarded(
  act: () => Promise<Outcome> | Outcome,
): Promise<Outcome> {
  try {
    return await act();
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// Posts `comments`, if any.
function post(effects: JobEffects, comments: Comment[]): Promise<Outcome> {
  if (comments.length === 0) {
    return ok();
  }
  return effects.op({ kind: "op", op: "post", payload: { comments } });
}

export type { Comment };
export { answer, guarded, ok, post, READER };
