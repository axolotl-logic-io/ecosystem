// @ts-check
// Every edge of the implementor's `fix` entry (#418; the wiki's
// Pipeline-Roles-Implementor, "Entry `fix`"), as a state, a result, the
// reply and data it is taken with, the next state, its effect (an op's,
// check's or session's name, or the end) and the data it changes. The
// limits are the machine's LIMITS: one continuation, two fix rounds. Every
// finding resolved carries on at checks in the same job (#424).
import { ACCEPTANCE_REASON, findingsText } from "../src/workflow/findings.ts";
import { outOfRoomReason } from "../src/workflow/stages/continuation.ts";
import { IN_ROUND, LENS_EDGES } from "./implementor-fix-lens-edges.mjs";
import {
  ACC,
  BACK,
  DIFF_PATH,
  DISPUTE,
  F1,
  FIX_DISPUTES_ACC,
  FIX_DONE,
  FIX_HANDOFF,
  FIXED_HEAD,
  FIXER_BAD_REPLY,
  NO_CODE,
  PATCH_ID,
  REINTRODUCED_REASON,
  REREVIEW_FAILED,
  remainReason,
  SEC,
} from "./implementor-fix-test-kit.mjs";
import { HANDOFF_FILE, stoppedWith } from "./implementor-role-test-kit.mjs";

/** @import { EdgeCase } from "./implementor-edge-fixtures.mjs" */
/** @import { Finding } from "./implementor-fix-test-kit.mjs" */
/** @import { End } from "../src/roles/machine.ts" */

const MAX_ROUNDS = 2;
/** @type {Finding} */
const RESOLVED_F1 = { ...F1, status: "resolved" };
// The end once every finding is resolved: saved at checks, carried on there.
/** @type {End} */
const NEXT_CHECKS = { kind: "next", stage: "checks" };
const DISPUTED_ACC = { ...ACC, disputed: true, dispute: DISPUTE.evidence };
// What the push's `fix-flows` check answers with.
const PUSHED_CODE = { headSha: FIXED_HEAD, flows: { code: true, wiki: false } };
const PUSHED_NONE = {
  headSha: FIXED_HEAD,
  flows: { code: false, wiki: false },
};
// What prepare-review replies.
const PREPARED = {
  ok: true,
  headSha: FIXED_HEAD,
  diffPath: DIFF_PATH,
  diffLines: "4",
  patchId: PATCH_ID,
};

/**
 * What update-findings answers with: the findings and history after the
 * verdicts, the next finding id, and the stop it found, if any.
 * @param {Finding[]} findings
 * @param {{ reason: string, detail: string } | null} [stop]
 */
function updated(findings, stop = null) {
  const resolvedHistory = findings
    .filter((f) => f.status === "resolved")
    .map((f) => `${f.id}: ${f.title}`);
  return { findings, resolvedHistory, nextFindingId: 1, stop };
}

/** @type {EdgeCase[]} */
// The shared start's edges are the start sync's (#419), in
// implementor-sync-edge-fixtures.mjs.
const FIX_EDGES = [
  {
    at: "fix-work?",
    result: "open",
    data: { fixRounds: 0 },
    next: "fixer",
    effect: "session:fix-r1",
    changes: { fixRounds: 1 },
  },
  {
    at: "fix-work?",
    result: "open",
    data: { fixRounds: MAX_ROUNDS },
    next: "findings-open",
    effect: stoppedWith(
      "review-rounds",
      remainReason(MAX_ROUNDS),
      findingsText([F1]),
    ),
    changes: { fixRounds: MAX_ROUNDS },
  },
  {
    at: "fix-work?",
    result: "none",
    data: { findings: [RESOLVED_F1] },
    next: "fixed",
    effect: NEXT_CHECKS,
  },
  {
    at: "fixer",
    result: "replied",
    reply: FIX_DONE,
    data: { fixRounds: 1 },
    next: "fixer-reply",
    effect: "check:fixer-reply",
    changes: { fixReply: FIX_DONE, round: 1 },
  },
  {
    at: "fixer",
    result: "replied",
    reply: FIX_DISPUTES_ACC,
    data: { fixRounds: 1, findings: [ACC] },
    next: "fixer-reply",
    effect: "check:fixer-reply",
    changes: { fixReply: FIX_DISPUTES_ACC, findings: [DISPUTED_ACC] },
  },
  {
    at: "fixer",
    result: "replied",
    reply: { status: "finished" },
    data: { fixRounds: 1 },
    next: "fixer-reply",
    effect: "check:fixer-reply",
    changes: { fixReply: null },
  },
  {
    at: "fixer-reply",
    result: "done",
    data: { fixRounds: 1, fixReply: FIX_DONE },
    next: "fix-flows",
    effect: "check:fix-flows",
  },
  {
    at: "fixer-reply",
    result: "handoff",
    data: { fixRounds: 1, fixReply: FIX_HANDOFF, fixContinuations: 0 },
    next: "fixer",
    effect: "session:fix-r1-c1",
    changes: { fixContinuations: 1, fixRounds: 1 },
  },
  {
    at: "fixer-reply",
    result: "handoff",
    data: { fixRounds: 1, fixReply: FIX_HANDOFF, fixContinuations: 1 },
    next: "fixer-out-of-room",
    effect: stoppedWith(
      "too-large",
      outOfRoomReason("fixer", 1),
      `Latest handoff: ${HANDOFF_FILE}\n\n${FIX_HANDOFF.summary}`,
    ),
  },
  {
    at: "fixer-reply",
    result: "acceptance",
    data: {
      fixRounds: 1,
      fixReply: FIX_DISPUTES_ACC,
      findings: [DISPUTED_ACC],
    },
    next: "acceptance-disputed",
    effect: stoppedWith(
      "acceptance",
      ACCEPTANCE_REASON,
      findingsText([DISPUTED_ACC]),
    ),
  },
  {
    at: "fixer-reply",
    result: "bad",
    data: { fixRounds: 1, fixReply: null },
    next: "fixer-bad-reply",
    effect: stoppedWith("error", FIXER_BAD_REPLY, ""),
  },
  {
    at: "fix-flows",
    result: "go",
    reply: PUSHED_CODE,
    data: { fixRounds: 1 },
    next: "prepare-rereview",
    effect: "op:prepare-review",
    changes: { headSha: FIXED_HEAD, flows: PUSHED_CODE.flows },
  },
  {
    at: "fix-flows",
    result: "reopen",
    reply: PUSHED_CODE,
    data: { fixRounds: 1, prClosed: true },
    next: "fix-reopen",
    effect: { kind: "saved", stage: "open-pr" },
    changes: { headSha: FIXED_HEAD, flows: PUSHED_CODE.flows },
  },
  {
    at: "fix-flows",
    result: "none",
    reply: PUSHED_NONE,
    data: { fixRounds: 1 },
    next: "fix-no-code",
    effect: stoppedWith("not-doable", NO_CODE, ""),
    changes: { headSha: FIXED_HEAD, flows: PUSHED_NONE.flows },
  },
  {
    at: "prepare-rereview",
    result: "ok",
    reply: PREPARED,
    data: { fixRounds: 1, headSha: FIXED_HEAD },
    next: "rereview-correctness?",
    effect: "check:rereview?",
    changes: { diffPath: DIFF_PATH, patchId: PATCH_ID },
  },
  ...LENS_EDGES,
  {
    at: "update-findings",
    result: "resolved",
    reply: updated([RESOLVED_F1]),
    data: { ...IN_ROUND, testsOnly: true },
    next: "fixed",
    effect: NEXT_CHECKS,
    changes: {
      findings: [RESOLVED_F1],
      resolvedHistory: ["f1: Off by one"],
      reviewedSha: FIXED_HEAD,
      reviewedPatchId: PATCH_ID,
      testsOnly: false,
    },
  },
  {
    at: "update-findings",
    result: "open",
    reply: updated([F1]),
    data: { ...IN_ROUND, reviewedPatchId: "old" },
    next: "fixer",
    effect: "session:fix-r2",
    changes: {
      fixRounds: 2,
      findings: [F1],
      reviewedSha: FIXED_HEAD,
      reviewedPatchId: "old",
    },
  },
  {
    at: "update-findings",
    result: "open",
    reply: updated([F1]),
    data: { ...IN_ROUND, fixRounds: MAX_ROUNDS },
    next: "findings-open",
    effect: stoppedWith(
      "review-rounds",
      remainReason(MAX_ROUNDS),
      findingsText([F1]),
    ),
    changes: { fixRounds: MAX_ROUNDS },
  },
  {
    at: "update-findings",
    result: "open",
    reply: updated([RESOLVED_F1, SEC]),
    data: { ...IN_ROUND, fixRounds: MAX_ROUNDS },
    next: "findings-open",
    effect: stoppedWith(
      "user-harm",
      `security review (user-harm): ${SEC.title} is still open after ${MAX_ROUNDS} fix rounds`,
      findingsText([SEC]),
    ),
  },
  {
    at: "update-findings",
    result: "reintroduced",
    reply: updated([RESOLVED_F1], {
      reason: REINTRODUCED_REASON,
      detail: `${BACK.title}\n${BACK.evidence}`,
    }),
    data: IN_ROUND,
    next: "reintroduced",
    effect: stoppedWith(
      "fix-loop",
      REINTRODUCED_REASON,
      `${BACK.title}\n${BACK.evidence}`,
    ),
  },
  {
    at: "update-findings",
    result: "bad",
    reply: updated([F1], { reason: REREVIEW_FAILED, detail: "" }),
    data: IN_ROUND,
    next: "rereview-bad",
    effect: stoppedWith("error", REREVIEW_FAILED, ""),
  },
];

export { FIX_EDGES, PREPARED, PUSHED_CODE };
