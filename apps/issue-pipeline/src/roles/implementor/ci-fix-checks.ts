// The job's checks that read the `checks` entry's session replies (the
// wiki's Pipeline-Roles-Implementor, "Entry `checks`"): the CI fixer's
// status, and the two check-fix reviews, which are posted on the PR and
// whose blocking findings go back to the fixer as its next failure.

import { z } from "zod";
import type { CheckEffect, Outcome } from "../../job/run-step.ts";
import { findingLines } from "../../workflow/findings.ts";
import type { Signature } from "../../workflow/signing.ts";
import { blockingIn, fixOf } from "../../workflow/stages/checks-reply.ts";
import type { ListedFinding } from "../../workflow/types.ts";
import type { Ops } from "./check-effects.ts";
import { posted, SHORT_SHA } from "./check-effects.ts";
import type { FixLens } from "./checks-data.ts";
import { REVIEWER_AGENT } from "./ci-fix-task.ts";
import { answer } from "./outcome.ts";

type Payload = CheckEffect["payload"];

const REVIEWS = z.looseObject({
  reviews: z.array(
    z.object({ lens: z.enum(["correctness", "scope"]), reply: z.unknown() }),
  ),
  headSha: z.string(),
  pr: z.number().nullable(),
});

function fixStatus(payload: Payload): Outcome {
  const { fix } = payload;
  const read = fixOf(fix);
  if (read === null) {
    return answer("bad");
  }
  return answer(read.status);
}

function reviewerBy(ops: Ops, lens: FixLens): Signature {
  return {
    role: `check-fix reviewer (${lens})`,
    agent: REVIEWER_AGENT,
    model: ops.models[lens],
    run: ops.jobId,
  };
}

function reviewBody(
  headSha: string,
  blocking: readonly ListedFinding[],
): string {
  let found = "No blocking findings.";
  if (blocking.length > 0) {
    found = `**Blocking**\n\n${findingLines(blocking)}`;
  }
  return `Review of the check fix in ${headSha.slice(0, SHORT_SHA)}.\n\n${found}`;
}

// Posts each readable review on the PR, then answers `bad` when a review
// didn't read, `blocking` with the blocking findings, or `clean`.
async function fixReview(ops: Ops, payload: Payload): Promise<Outcome> {
  const { reviews, headSha, pr } = REVIEWS.parse(payload);
  const comments: { by: Signature; body: string }[] = [];
  const blocking: ListedFinding[] = [];
  let unread = false;
  for (const { lens, reply } of reviews) {
    const found = blockingIn(reply);
    if (found === null) {
      unread = true;
    } else {
      const body = reviewBody(headSha, found);
      comments.push({ by: reviewerBy(ops, lens), body });
      blocking.push(...found);
    }
  }
  if (comments.length > 0) {
    const done = await posted(ops, pr, comments);
    if (!done.ok) {
      return done;
    }
  }
  if (unread) {
    return answer("bad");
  }
  if (blocking.length > 0) {
    const failure = blocking
      .map((f) => `${f.file}:${f.line} ${f.title} - ${f.evidence}`)
      .join("\n");
    return answer("blocking", { failure });
  }
  return answer("clean");
}

export { fixReview, fixStatus };
