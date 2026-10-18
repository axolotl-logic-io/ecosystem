// The reviewer's `prepare` check: the prepare-review op on the issue's
// branch. It answers `ok` with the op's reply, which holds the review
// bundle's path and text (`bundlePath`, `bundleText`) when the op wrote one,
// `empty` when the branch changes no file, or the op's failure.

import { z } from "zod";
import type { Outcome } from "../../job/run-step.ts";
import type { Entry } from "../../job/runner.ts";
import { stackFields } from "../../workflow/stages/stacked.ts";
import type { JobEffects } from "../registry.ts";

const PREPARED = z.looseObject({ changedFiles: z.array(z.string()) });

async function prepare(entry: Entry, effects: JobEffects): Promise<Outcome> {
  const payload = {
    number: entry.context.issue,
    tag: "r0",
    ...stackFields(entry.saved.stackedOn),
  };
  const done = await effects.op({ kind: "op", op: "prepare-review", payload });
  if (!done.ok) {
    return done;
  }
  const reply = PREPARED.parse(done.reply);
  if (reply.changedFiles.length === 0) {
    return { ok: true, name: "empty", reply: null };
  }
  return { ok: true, name: "ok", reply };
}

export { prepare };
