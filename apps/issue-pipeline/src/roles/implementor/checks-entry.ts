// The implementor's `checks` entry (the wiki's Pipeline-Roles-Implementor,
// "Entry `checks`"): skip a head already verified, run the wiki check, the
// repo's commands and CI, and on a failure run the CI fixer, push its fix
// and have two lenses review the fix's diff before the checks run again.
// Each failure that reaches the fixer, a blocking review finding's
// included, is one CI-fix round, up to maxCiFixes; each fixer's handoff
// takes a continuation, up to maxContinuations. The job's checks
// (checks-ops.ts) run the ops and read their replies; no state touches the
// PR. Pure.

import { z } from "zod";
import { flowsOf } from "../../workflow/flows.ts";
import { fixOf } from "../../workflow/stages/checks-reply.ts";
import { patchIdIn } from "../../workflow/stages/reply-guards.ts";
import { stackFields } from "../../workflow/stages/stacked.ts";
import type { Edge, Guard } from "../machine.ts";
import type { ChecksStep, FixLens } from "./checks-data.ts";
import { ciFixerSession, fixerBy, fixReviewSession } from "./ci-fix-task.ts";
import type { ImplData, ImplState } from "./locate.ts";
import type { ImplSpec, ImplStates } from "./states.ts";
import { check, op } from "./states.ts";

// What the failing checks, verify's pass and the fix's push answer with.
const FAILED = z.looseObject({ failure: z.string() });
const VERIFIED = z.looseObject({ headSha: z.string(), summary: z.string() });
const PUSHED = z.looseObject({
  headSha: z.string(),
  codeChanged: z.boolean(),
  wikiAhead: z.number(),
});
// What the fix's review diff answers with.
const DIFF = z.looseObject({ diffPath: z.string() });

// How much longer than the config's CI wait the CI op may take.
const CI_WAIT_MARGIN_MINUTES = 10;
const WIKI_ONLY_SUMMARY = "wiki-check: passed; no code changed";

const CI_FIXES: Guard<ImplState, ImplData> = {
  field: "ciFixRounds",
  limit: "maxCiFixes",
  over: "fix-limit",
};

const FIX_CONTINUATIONS: Guard<ImplState, ImplData> = {
  field: "ciFixContinuations",
  limit: "maxContinuations",
  over: "fix-out-of-room",
};

// A failure for the CI fixer, which a fresh session works on. It is set
// before the round's guard, so a stop at the limit has it as its detail.
function failedWith(data: ImplData, reply: unknown): ImplData {
  const failure = FAILED.safeParse(reply).data?.failure ?? data.failure;
  return { ...data, failure, fix: null };
}

// Every failure goes to the CI fixer, one round each.
const TO_FIXER: Edge<ImplState, ImplData> = {
  to: "ci-fixer",
  apply: failedWith,
  count: CI_FIXES,
};

// The checks passed: a tests-only rerun goes on to merge.
function passed(data: ImplData): ImplData {
  return { ...data, rebasedOnly: data.testsOnly === true, testsOnly: false };
}

function wikiOnly(data: ImplData): ImplData {
  return {
    ...passed(data),
    verifiedSha: data.headSha ?? null,
    verifySummary: WIKI_ONLY_SUMMARY,
  };
}

function verified(data: ImplData, reply: unknown): ImplData {
  const parsed = VERIFIED.safeParse(reply);
  if (!parsed.success) {
    return data;
  }
  const { headSha, summary } = parsed.data;
  return { ...data, verifiedSha: headSha, verifySummary: summary };
}

// The fix's pushed head and flows. A fix changes code, so every check runs
// again.
function pushedFix(data: ImplData, reply: unknown): ImplData {
  const parsed = PUSHED.safeParse(reply);
  if (!parsed.success) {
    return data;
  }
  const { headSha, codeChanged, wikiAhead } = parsed.data;
  const flows = flowsOf({ codeChanged, wikiAhead });
  return { ...data, headSha, flows, testsOnly: false };
}

function prepared(data: ImplData, reply: unknown): ImplData {
  return {
    ...data,
    diffPath: DIFF.safeParse(reply).data?.diffPath ?? null,
    patchId: patchIdIn(reply),
    reviews: [],
  };
}

function reviewed(lens: FixLens): (data: ImplData, reply: unknown) => ImplData {
  return (data: ImplData, reply: unknown): ImplData => ({
    ...data,
    reviews: [...data.reviews, { lens, reply }],
  });
}

// The fix passed its review: its head is the reviewed one now.
function cleared(data: ImplData): ImplData {
  return {
    ...data,
    reviewedSha: data.headSha ?? null,
    reviewedPatchId: data.patchId,
    testsOnly: false,
  };
}

function reviewSession(lens: FixLens, next: ImplState): ImplSpec {
  return {
    kind: "session",
    effect: fixReviewSession(lens),
    on: { replied: { to: next, apply: reviewed(lens) } },
  };
}

// The fixer's summary, posted with its push on the PR (the issue without
// one).
function fixComments(data: ImplData): Readonly<Record<string, unknown>> {
  const comment = {
    number: data.pr ?? data.issue,
    by: fixerBy(data),
    body: data.fix?.summary ?? "",
  };
  return { comments: [comment] };
}

const CHECKS_STATES: ImplStates<ChecksStep> = {
  "checks-work?": check(
    "checks-work?",
    (data: ImplData) => ({
      headSha: data.headSha ?? null,
      verifiedSha: data.verifiedSha,
      flows: data.flows ?? null,
    }),
    { verified: { to: "ci-status" }, work: { to: "wiki-check" } },
  ),
  "wiki-check": check(
    "wiki-check",
    (data: ImplData) => ({
      flows: data.flows ?? null,
      headSha: data.headSha ?? null,
    }),
    {
      pass: { to: "verify" },
      "wiki-only": { to: "checked", apply: wikiOnly },
      fail: TO_FIXER,
    },
  ),
  verify: check(
    "verify",
    (data: ImplData) => ({
      headSha: data.headSha ?? null,
      testsOnly: data.testsOnly === true,
      pr: data.pr ?? null,
      ...stackFields(data.stackedOn),
    }),
    {
      pass: { to: "ci-status", apply: verified },
      fail: TO_FIXER,
      moved: { to: "verify-moved" },
    },
  ),
  "ci-status": check(
    "ci-status",
    (data: ImplData) => ({
      pr: data.pr ?? null,
      expectedSha: data.headSha ?? null,
      minutes: data.settings.cfg.ciWaitMinutes + CI_WAIT_MARGIN_MINUTES,
    }),
    {
      green: { to: "checked", apply: passed },
      pending: { to: "ci-pending" },
      fail: TO_FIXER,
      moved: { to: "ci-moved" },
      "no-checks": { to: "no-ci" },
    },
  ),
  "ci-fixer": {
    kind: "session",
    effect: ciFixerSession,
    on: {
      replied: {
        to: "ci-fixer-reply",
        apply: (data: ImplData, reply: unknown) => ({
          ...data,
          fix: fixOf(reply),
        }),
      },
    },
  },
  "ci-fixer-reply": check(
    "ci-fixer-reply",
    (data: ImplData) => ({ fix: data.fix }),
    {
      fixed: { to: "fix-push" },
      handoff: { to: "ci-fixer", count: FIX_CONTINUATIONS },
      "cannot-fix": { to: "checks-unrelated" },
      bad: { to: "bad-fix-reply" },
    },
  ),
  "fix-push": op("push", fixComments, {
    to: "prepare-fix-review",
    apply: pushedFix,
  }),
  "prepare-fix-review": op(
    "prepare-review",
    (data: ImplData) => ({
      sinceSha: data.reviewedSha,
      tag: `cifix${data.ciFixRounds}`,
      ...stackFields(data.stackedOn),
    }),
    { to: "check-fix-correctness", apply: prepared },
  ),
  "check-fix-correctness": reviewSession("correctness", "check-fix-scope"),
  "check-fix-scope": reviewSession("scope", "check-fix-review"),
  "check-fix-review": check(
    "check-fix-review",
    (data: ImplData) => ({
      reviews: data.reviews,
      headSha: data.headSha ?? null,
      pr: data.pr ?? null,
    }),
    {
      clean: { to: "wiki-check", apply: cleared },
      blocking: TO_FIXER,
      bad: { to: "bad-review" },
    },
  ),
};

export { CHECKS_STATES };
