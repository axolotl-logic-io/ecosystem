// How the implementor's script checks answer (checks.ts, fix-checks.ts),
// and what the push's `flows` check answers with, which the `implement`
// and `fix` entries read.

import { z } from "zod";
import type { Outcome } from "../../job/run-step.ts";

// What the `flows` check answers with after the push.
const PUSHED = z.looseObject({
  headSha: z.string(),
  flows: z.object({ code: z.boolean(), wiki: z.boolean() }),
});

function answer(name: string, reply: unknown = null): Outcome {
  return { ok: true, name, reply };
}

// Runs `act`, and turns a thrown error into a failed outcome.
async function guarded(
  act: () => Promise<Outcome> | Outcome,
): Promise<Outcome> {
  try {
    return await act();
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export { answer, guarded, PUSHED };
