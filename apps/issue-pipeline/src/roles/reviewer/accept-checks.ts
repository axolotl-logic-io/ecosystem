// The reviewer's `accept` entry's script checks (#423; the wiki's
// Pipeline-Roles-Reviewer, "Entry `accept`" and "Acceptance"):
// `prepare-accept` (the prepare-review op for the final diff, only good while
// the branch is still at `verifiedSha`), `accept-work?` (whether the changes
// keep the verdict acceptance last passed, review-keeps-on-clean-rebase) and
// `post-verdict` (the verifier's verdict, posted). Each answers with one of
// the machine's result names; the comments go on the PR, or the issue when
// there is none.

import { z } from "zod";
import type { CheckEffect, Outcome } from "../../job/run-step.ts";
import type { Entry } from "../../job/runner.ts";
import { byStep } from "../../workflow/signing.ts";
import {
  ACCEPT_ROLE,
  keptText,
  verdictText,
} from "../../workflow/stages/accept.ts";
import { isNetworkError } from "../../workflow/stages/network.ts";
import { acceptReplyOf } from "../../workflow/stages/replies.ts";
import { isRecord } from "../../workflow/stages/reply-guards.ts";
import { stackFields } from "../../workflow/stages/stacked.ts";
import type { Checks, JobEffects } from "../registry.ts";
import { answer, guarded, post, READER } from "./posting.ts";

type Payload = CheckEffect["payload"];

const ON_ISSUE = z.looseObject({
  number: z.number(),
  pr: z.number().nullable(),
});
const PREPARING = z.looseObject({ verifiedSha: z.string().nullable() });
const WORK = ON_ISSUE.extend({
  patchId: z.string().nullable(),
  acceptedPatchId: z.string().nullable(),
  acceptedSha: z.string().nullable(),
});
const VERDICT = ON_ISSUE.extend({ verdict: z.unknown() });

// The final diff at the verified head: `ok` with prepare-review's reply,
// `moved` when the branch is no longer at `verifiedSha`, `deferred` on a
// network failure, or the op's failure.
async function prepareAccept(
  entry: Entry,
  effects: JobEffects,
  verifiedSha: string | null,
): Promise<Outcome> {
  const payload = {
    number: entry.context.issue,
    tag: "final",
    ...stackFields(entry.saved.stackedOn),
  };
  const done = await effects.op({ kind: "op", op: "prepare-review", payload });
  if (!done.ok) {
    if (isNetworkError(done.error)) {
      return answer("deferred", done.error);
    }
    return done;
  }
  const { reply } = done;
  if (!isRecord(reply)) {
    return answer("moved");
  }
  const { headSha } = reply;
  if (headSha !== verifiedSha) {
    return answer("moved");
  }
  return answer("ok", reply);
}

// `kept`, after commenting so, when the changes' patch id is the one
// acceptance last passed; `run` otherwise.
async function acceptWork(
  effects: JobEffects,
  work: z.infer<typeof WORK>,
): Promise<Outcome> {
  const { patchId, acceptedPatchId, acceptedSha } = work;
  if (patchId === null || patchId !== acceptedPatchId) {
    return answer("run");
  }
  const number = work.pr ?? work.number;
  const body = `✅ ${keptText(acceptedSha)}.`;
  const posted = await post(effects, [
    { number, by: byStep(ACCEPT_ROLE), body },
  ]);
  if (!posted.ok) {
    return posted;
  }
  return answer("kept");
}

// Posts the verifier's verdict and answers `pass` or `fail` with it, or
// `unreadable` when the reply doesn't fit its schema.
async function postVerdict(
  entry: Entry,
  effects: JobEffects,
  given: z.infer<typeof VERDICT>,
): Promise<Outcome> {
  const reply = acceptReplyOf(given.verdict);
  if (reply === null) {
    return answer("unreadable");
  }
  const { models, jobId } = entry.context;
  const by = {
    role: ACCEPT_ROLE,
    agent: READER,
    model: models.verifier,
    run: jobId,
  };
  const number = given.pr ?? given.number;
  const posted = await post(effects, [
    { number, by, body: verdictText(reply) },
  ]);
  if (!posted.ok) {
    return posted;
  }
  return answer(reply.verdict, reply);
}

// The `accept` entry's checks for the run from `entry`, with ops through
// `effects`.
function acceptChecks(entry: Entry, effects: JobEffects): Checks {
  return {
    "prepare-accept": (payload: Payload) =>
      guarded(() =>
        prepareAccept(entry, effects, PREPARING.parse(payload).verifiedSha),
      ),
    "accept-work?": (payload: Payload) =>
      guarded(() => acceptWork(effects, WORK.parse(payload))),
    "post-verdict": (payload: Payload) =>
      guarded(() => postVerdict(entry, effects, VERDICT.parse(payload))),
  };
}

export { acceptChecks };
