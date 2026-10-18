// The reviewer's script checks (#421; the wiki's Pipeline-Roles-Reviewer,
// "Entry `review`"): claim and checkout, `prepare` (the prepare-review op and
// the bundle it replies, prepare.ts), `post-lenses` (one signed, keyed comment
// per lens) and `store-findings` (numbering with addFinding), and the
// `accept` entry's checks (accept-checks.ts, #423). Each answers with one of
// the machine's result names. The job has already claimed the issue and
// checked out its branch, so the claim answers ok and the checkout answers
// with the entry the run takes.
// The registry passes them to machineRole for every stage in
// REVIEWER_STAGES.

import { z } from "zod";
import type { Config } from "../../config.ts";
import type { CheckEffect, Outcome } from "../../job/run-step.ts";
import type { Entry } from "../../job/runner.ts";
import { addFinding } from "../../workflow/findings.ts";
import type { ReviewLens } from "../../workflow/lenses.ts";
import { LENS_NAMES } from "../../workflow/lenses.ts";
import { byStep } from "../../workflow/signing.ts";
import type {
  MergedFinding,
  RawFinding,
  ReviewFinding,
} from "../../workflow/stages/review-replies.ts";
import {
  mergedFindingsOf,
  rawFindingsOf,
  reviewFindingsOf,
} from "../../workflow/stages/review-replies.ts";
import {
  findingIdsComment,
  lensComment,
} from "../../workflow/stages/review-text.ts";
import type { Finding, IssueState } from "../../workflow/types.ts";
import type { Checks, JobEffects } from "../registry.ts";
import type { SessionsReply } from "../sessions.ts";
import { sessionsReplyOf } from "../sessions.ts";
import { acceptChecks } from "./accept-checks.ts";
import type { Comment } from "./posting.ts";
import { answer, guarded, ok, post, READER } from "./posting.ts";
import { prepare } from "./prepare.ts";

type Payload = CheckEffect["payload"];

const ENTERED = z.looseObject({ entry: z.enum(["review", "accept"]) });
const ON_ISSUE = z.looseObject({
  number: z.number(),
  pr: z.number().nullable(),
});
const POSTED = ON_ISSUE.extend({
  headSha: z.string().nullable(),
  replies: z.unknown(),
});
const STORE = ON_ISSUE.extend({
  nextFindingId: z.number(),
  raw: z.unknown(),
  merged: z.unknown(),
});

// What the lenses said: each one's comment, the blocking findings with their
// lens, and the first failure.
interface Reviews {
  comments: Comment[];
  raw: RawFinding[];
  failure: string | null;
}

// The run, its effects, and where its comments go.
interface ReviewJob {
  entry: Entry;
  effects: JobEffects;
  // The PR comments go on, or the issue when there is none.
  number: number;
}

// The lens's findings, or why it has none.
function findingsOf(
  replies: SessionsReply,
  lens: ReviewLens,
): ReviewFinding[] | string {
  const failed = `${lens} reviewer failed:`;
  const replied = replies.find(({ name }) => name === `review-${lens}`);
  if (replied === undefined) {
    return `${failed} no output`;
  }
  const { outcome } = replied;
  if (!outcome.ok) {
    return `${failed} ${outcome.error}`;
  }
  return reviewFindingsOf(outcome.reply) ?? `${failed} no output`;
}

// Each lens's signed comment on `headSha`, its blocking findings, and the
// first lens that failed.
function readReviews(
  job: ReviewJob,
  replies: SessionsReply,
  headSha: string,
): Reviews {
  const { models, jobId } = job.entry.context;
  const reviews: Reviews = { comments: [], raw: [], failure: null };
  for (const lens of LENS_NAMES) {
    const found = findingsOf(replies, lens);
    if (typeof found === "string") {
      reviews.failure ??= found;
    } else {
      const blocking = found.filter((f) => f.severity === "blocking");
      const nits = found.filter((f) => f.severity !== "blocking");
      reviews.raw.push(...blocking.map((f) => ({ lens, ...f })));
      const role = `reviewer (${lens})`;
      const by = { role, agent: READER, model: models[lens], run: jobId };
      const body = lensComment(headSha, lens, blocking, nits);
      const { number } = job;
      reviews.comments.push({ number, by, body, key: `review-${lens}` });
    }
  }
  return reviews;
}

// Posts each lens's comment, then answers whether a lens failed, the review
// is clean, or it has blocking findings.
async function postLenses(
  job: ReviewJob,
  payload: z.infer<typeof POSTED>,
): Promise<Outcome> {
  const replies = sessionsReplyOf(payload.replies) ?? [];
  const reviews = readReviews(job, replies, payload.headSha ?? "");
  const posted = await post(job.effects, reviews.comments);
  if (!posted.ok) {
    return posted;
  }
  if (reviews.failure !== null) {
    return answer("lens-failed", reviews.failure);
  }
  if (reviews.raw.length === 0) {
    return answer("clean");
  }
  return answer("blocking", reviews.raw);
}

function lensesOf(finding: MergedFinding): string[] {
  if (finding.lenses.length > 0) {
    return finding.lenses;
  }
  return ["correctness"];
}

// Numbers the merged findings, or the raw ones if the aggregator failed,
// from the saved next number, and posts the comment that lists them.
async function storeFindings(
  job: ReviewJob,
  payload: z.infer<typeof STORE>,
): Promise<Outcome> {
  const { models, jobId } = job.entry.context;
  const merged = mergedFindingsOf(payload.merged);
  const st: Pick<IssueState, "findings" | "nextFindingId"> = {
    findings: [],
    nextFindingId: payload.nextFindingId,
  };
  const holder = { st };
  let added: Finding[] = [];
  let by = byStep("aggregator (fallback: raw findings)");
  if (merged === null) {
    const raw = rawFindingsOf(payload.raw);
    added = raw.map((f) => addFinding(holder, f, [f.lens]));
  } else {
    added = merged.map((f) => addFinding(holder, f, lensesOf(f)));
    const model = models.aggregator;
    by = { role: "aggregator", agent: READER, model, run: jobId };
  }
  const { number } = job;
  const body = findingIdsComment(added);
  const posted = await post(job.effects, [{ number, by, body }]);
  if (!posted.ok) {
    return posted;
  }
  return answer("ok", { findings: added, nextFindingId: st.nextFindingId });
}

// The reviewer's checks for the run from `entry`, with ops through
// `effects`.
function reviewerChecks(
  entry: Entry,
  effects: JobEffects,
  _cfg: Config,
): Checks {
  function jobOn(payload: Payload): ReviewJob {
    const { number, pr } = ON_ISSUE.parse(payload);
    return { entry, effects, number: pr ?? number };
  }
  return {
    claim: ok,
    // The checkout answers with the entry the run takes.
    checkout: (payload: Payload) =>
      guarded(() => answer(ENTERED.parse(payload).entry)),
    prepare: () => guarded(() => prepare(entry, effects)),
    "post-lenses": (payload: Payload) =>
      guarded(() => postLenses(jobOn(payload), POSTED.parse(payload))),
    "store-findings": (payload: Payload) =>
      guarded(() => storeFindings(jobOn(payload), STORE.parse(payload))),
    ...acceptChecks(entry, effects),
  };
}

export { reviewerChecks };
