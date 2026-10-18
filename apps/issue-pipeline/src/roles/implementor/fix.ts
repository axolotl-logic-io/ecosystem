// The implementor's `fix` entry (#418; the wiki's Pipeline-Roles-Implementor,
// "Entry `fix`", and Pipeline-Roles-Reviewer, "Re-review"): the fixer with
// its continuations, the push and its flows, the re-review diff, one
// re-reviewer per lens with open findings, in ALL_LENSES order, and the
// findings' update, bounded by fixRounds. Every state but the sessions is a
// check or an op; no state touches the PR. Pure.

import { z } from "zod";
import type { Lens } from "../../workflow/lenses.ts";
import { ALL_LENSES } from "../../workflow/lenses.ts";
import { patchIdIn } from "../../workflow/stages/reply-guards.ts";
import { fixReplyOf } from "../../workflow/stages/review-replies.ts";
import { stackFields } from "../../workflow/stages/stacked.ts";
import type { Guard } from "../machine.ts";
import { findingsOf } from "./fix-data.ts";
import type { FixEnd } from "./fix-ends.ts";
import { FIX_END_STATES } from "./fix-ends.ts";
import {
  fixerSession,
  lensFindings,
  openOf,
  rereviewerSession,
} from "./fix-task.ts";
import {
  disputedAcceptance,
  disputedFindings,
  fixerComments,
  updateOf,
} from "./fix-update.ts";
import { pushed } from "./implement.ts";
import type { ImplData, ImplState } from "./locate.ts";
import type { ImplSpec, ImplStates } from "./states.ts";
import { check } from "./states.ts";

// The `fix` entry's states and its ends.
type FixState =
  | "fix-work?"
  | "fixer"
  | "fixer-reply"
  | "fix-flows"
  | "prepare-rereview"
  | `rereview-${Lens}?`
  | `rereview-${Lens}`
  | "update-findings"
  | FixEnd;

const FIX_ROUNDS: Guard<ImplState, ImplData> = {
  field: "fixRounds",
  limit: "maxFixRounds",
  over: "findings-open",
};

const FIX_CONTINUATIONS: Guard<ImplState, ImplData> = {
  field: "fixContinuations",
  limit: "maxContinuations",
  over: "fixer-out-of-room",
};

// What update-findings answers with (fix-update.ts FindingsUpdate).
const UPDATE = z.object({
  findings: z.array(z.unknown()),
  resolvedHistory: z.array(z.string()),
  nextFindingId: z.number(),
  stop: z.object({ reason: z.string(), detail: z.string() }).nullable(),
});

// A new round starts from the open findings, with no fixer reply yet.
function newRound(data: ImplData): ImplData {
  return { ...data, fixReply: null };
}

// The fixer's reply, its round, and the disputes it records.
function fixerReplied(data: ImplData, reply: unknown): ImplData {
  const fixReply = fixReplyOf(reply);
  let { findings } = data;
  if (fixReply !== null) {
    findings = disputedFindings(findingsOf(findings), fixReply.disputed);
  }
  return { ...data, fixReply, findings, round: data.fixRounds };
}

// The re-review diff, with no lens's reply yet.
function prepared(data: ImplData, reply: unknown): ImplData {
  const parsed = z.looseObject({ diffPath: z.string() }).safeParse(reply);
  const diffPath = parsed.data?.diffPath ?? null;
  return { ...data, diffPath, patchId: patchIdIn(reply), rereviews: {} };
}

// The findings, history and next id update-findings answered with, and the
// stop it found; the data unchanged when the reply doesn't read.
function updated(data: ImplData, reply: unknown): ImplData {
  const parsed = UPDATE.safeParse(reply);
  if (!parsed.success) {
    return data;
  }
  const { resolvedHistory, nextFindingId, stop } = parsed.data;
  const findings = findingsOf(parsed.data.findings);
  return { ...data, findings, resolvedHistory, nextFindingId, fixStop: stop };
}

// Every finding resolved: the head is reviewed, with the round's patch id.
function resolved(data: ImplData, reply: unknown): ImplData {
  const next = updated(data, reply);
  const reviewedSha = next.headSha ?? null;
  const { patchId: reviewedPatchId } = next;
  return { ...next, reviewedSha, reviewedPatchId, testsOnly: false };
}

// Findings still open: the head is reviewed, and the next round begins.
function stillOpen(data: ImplData, reply: unknown): ImplData {
  const next = updated(data, reply);
  return newRound({ ...next, reviewedSha: next.headSha ?? null });
}

// The request for the diff since the reviewed head, tagged by the round,
// after the security rounds if any, on the issue's stack.
function preparePayload(data: ImplData): Readonly<Record<string, unknown>> {
  let tag = `r${data.fixRounds}`;
  if (data.securityRounds > 0) {
    tag = `s${data.securityRounds}-${tag}`;
  }
  const fields = { sinceSha: data.reviewedSha, tag };
  return { number: data.issue, ...fields, ...stackFields(data.stackedOn) };
}

// The state after `lens`'s re-review: the next lens's check, or the update.
function afterLens(lens: Lens): ImplState {
  const next = ALL_LENSES[ALL_LENSES.indexOf(lens) + 1];
  if (next === undefined) {
    return "update-findings";
  }
  return `rereview-${next}?`;
}

// Whether `lens` has open findings to re-review.
function lensCheck(lens: Lens): ImplSpec {
  return check(
    "rereview?",
    (data: ImplData) => ({ lens, open: lensFindings(data, lens).length }),
    { open: { to: `rereview-${lens}` }, none: { to: afterLens(lens) } },
  );
}

// `lens`'s re-reviewer, whose reply is kept by lens for the update.
function lensSession(lens: Lens): ImplSpec {
  function kept(data: ImplData, reply: unknown): ImplData {
    return { ...data, rereviews: { ...data.rereviews, [lens]: reply ?? null } };
  }
  return {
    kind: "session",
    effect: rereviewerSession(lens),
    on: { replied: { to: afterLens(lens), apply: kept } },
  };
}

const FIX_STATES: ImplStates<FixState> = {
  "fix-work?": check("fix-work?", (data) => ({ open: openOf(data).length }), {
    open: { to: "fixer", count: FIX_ROUNDS, apply: newRound },
    none: { to: "fixed" },
  }),
  fixer: {
    kind: "session",
    effect: fixerSession,
    on: { replied: { to: "fixer-reply", apply: fixerReplied } },
  },
  "fixer-reply": check(
    "fixer-reply",
    (data: ImplData) => ({
      status: data.fixReply?.status ?? null,
      disputed: disputedAcceptance(data) !== null,
      comments: fixerComments(data),
    }),
    {
      acceptance: { to: "acceptance-disputed" },
      done: { to: "fix-flows" },
      handoff: { to: "fixer", count: FIX_CONTINUATIONS },
      bad: { to: "fixer-bad-reply" },
    },
  ),
  "fix-flows": check(
    "fix-flows",
    (data: ImplData) => ({
      prClosed: data.prClosed || typeof data.pr !== "number",
    }),
    {
      go: { to: "prepare-rereview", apply: pushed },
      reopen: { to: "fix-reopen", apply: pushed },
      none: { to: "fix-no-code", apply: pushed },
    },
  ),
  "prepare-rereview": {
    kind: "script",
    effect: (data: ImplData) => ({
      kind: "op",
      op: "prepare-review",
      payload: preparePayload(data),
    }),
    on: { ok: { to: "rereview-correctness?", apply: prepared } },
  },
  "rereview-correctness?": lensCheck("correctness"),
  "rereview-correctness": lensSession("correctness"),
  "rereview-tests?": lensCheck("tests"),
  "rereview-tests": lensSession("tests"),
  "rereview-scope?": lensCheck("scope"),
  "rereview-scope": lensSession("scope"),
  "rereview-security?": lensCheck("security"),
  "rereview-security": lensSession("security"),
  "rereview-acceptance?": lensCheck("acceptance"),
  "rereview-acceptance": lensSession("acceptance"),
  "update-findings": check(
    "update-findings",
    (data) => ({ ...updateOf(data) }),
    {
      resolved: { to: "fixed", apply: resolved },
      open: { to: "fixer", count: FIX_ROUNDS, apply: stillOpen },
      reintroduced: { to: "reintroduced", apply: updated },
      bad: { to: "rereview-bad", apply: updated },
    },
  ),
  ...FIX_END_STATES,
};

export type { FixState };
export { FIX_STATES };
