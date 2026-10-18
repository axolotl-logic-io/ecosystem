// @ts-check
// Every edge of the implementor's `checks` entry from its CI fixer on (#420;
// the wiki's Pipeline-Roles-Implementor, "Entry `checks`"): the fixer, its
// push, the fix's review diff and its two reviewers, in the format of
// implementor-checks-edge-fixtures.mjs.

import { AT_LIMIT, OUT_OF_ROOM } from "./implementor-checks-edge-fixtures.mjs";
import {
  BAD_FIX_REPLY,
  BAD_REVIEW,
  CANNOT_FIX,
  CANNOT_FIX_REASON,
  CLEAN_REVIEW,
  CODE_FLOWS,
  FIXED,
  FIXED_HEAD,
  fixLimit,
  HANDOFF_FIX,
} from "./implementor-checks-test-kit.mjs";

/** @import { ChecksEdge } from "./implementor-checks-edge-fixtures.mjs" */

const CORRECTNESS = { lens: "correctness", reply: CLEAN_REVIEW };
const SCOPE = { lens: "scope", reply: CLEAN_REVIEW };
const BLOCKING = "src/a.ts:3 Drops the error - The catch swallows it.";
const DIFF = { ok: true, diffPath: "/runs/issue-7/cifix1.diff", patchId: "p1" };
const PUSH = { ok: true, headSha: FIXED_HEAD, codeChanged: true, wikiAhead: 0 };

/** @type {ChecksEdge[]} */
const FIX_EDGES = [
  {
    at: "ci-fixer",
    result: "replied",
    reply: FIXED,
    data: { ciFixRounds: 1 },
    next: "ci-fixer-reply",
    effect: "check:ci-fixer-reply",
    changes: { fix: FIXED },
  },
  {
    at: "ci-fixer",
    result: "replied",
    reply: { status: "finished" },
    data: { ciFixRounds: 1 },
    next: "ci-fixer-reply",
    effect: "check:ci-fixer-reply",
    changes: { fix: null },
  },
  {
    at: "ci-fixer-reply",
    result: "fixed",
    data: { fix: FIXED, ciFixRounds: 1 },
    next: "fix-push",
    effect: "op:push",
  },
  {
    at: "ci-fixer-reply",
    result: "handoff",
    data: { fix: HANDOFF_FIX, ciFixRounds: 1, ciFixContinuations: 0 },
    next: "ci-fixer",
    effect: "session:cifix-1-c1",
    changes: { ciFixContinuations: 1, ciFixRounds: 1 },
  },
  {
    at: "ci-fixer-reply",
    result: "handoff",
    data: { fix: HANDOFF_FIX, ciFixRounds: 1, ciFixContinuations: 1 },
    next: "fix-out-of-room",
    effect: { stop: "too-large", reason: OUT_OF_ROOM },
  },
  {
    at: "ci-fixer-reply",
    result: "cannot-fix",
    data: { fix: CANNOT_FIX, ciFixRounds: 1 },
    next: "checks-unrelated",
    effect: { stop: "checks-unrelated", reason: CANNOT_FIX_REASON },
  },
  {
    at: "ci-fixer-reply",
    result: "bad",
    data: { fix: null, ciFixRounds: 1 },
    next: "bad-fix-reply",
    effect: { stop: "error", reason: BAD_FIX_REPLY },
  },
  {
    at: "fix-push",
    result: "ok",
    reply: PUSH,
    data: { fix: FIXED, ciFixRounds: 1, testsOnly: true },
    next: "prepare-fix-review",
    effect: "op:prepare-review",
    changes: { headSha: FIXED_HEAD, flows: CODE_FLOWS, testsOnly: false },
  },
  {
    at: "prepare-fix-review",
    result: "ok",
    reply: DIFF,
    data: { ciFixRounds: 1, headSha: FIXED_HEAD },
    next: "check-fix-correctness",
    effect: "session:cifix-review-correctness-1",
    changes: { diffPath: DIFF.diffPath, patchId: "p1", reviews: [] },
  },
  {
    at: "check-fix-correctness",
    result: "replied",
    reply: CLEAN_REVIEW,
    data: { ciFixRounds: 1, diffPath: DIFF.diffPath, reviews: [] },
    next: "check-fix-scope",
    effect: "session:cifix-review-scope-1",
    changes: { reviews: [CORRECTNESS] },
  },
  {
    at: "check-fix-scope",
    result: "replied",
    reply: CLEAN_REVIEW,
    data: { ciFixRounds: 1, diffPath: DIFF.diffPath, reviews: [CORRECTNESS] },
    next: "check-fix-review",
    effect: "check:check-fix-review",
    changes: { reviews: [CORRECTNESS, SCOPE] },
  },
  {
    at: "check-fix-review",
    result: "clean",
    data: {
      ciFixRounds: 1,
      headSha: FIXED_HEAD,
      patchId: "p1",
      testsOnly: true,
      reviews: [CORRECTNESS, SCOPE],
    },
    next: "wiki-check",
    effect: "check:wiki-check",
    changes: {
      reviewedSha: FIXED_HEAD,
      reviewedPatchId: "p1",
      testsOnly: false,
    },
  },
  {
    at: "check-fix-review",
    result: "blocking",
    reply: { failure: BLOCKING },
    data: { ciFixRounds: 1, fix: FIXED, headSha: FIXED_HEAD },
    next: "ci-fixer",
    effect: "session:cifix-2",
    changes: { ciFixRounds: 2, failure: BLOCKING, fix: null },
  },
  {
    at: "check-fix-review",
    result: "blocking",
    reply: { failure: BLOCKING },
    data: { ...AT_LIMIT, fix: FIXED, headSha: FIXED_HEAD },
    next: "fix-limit",
    effect: { stop: "check-fixes", reason: fixLimit(2) },
  },
  {
    at: "check-fix-review",
    result: "bad",
    data: { ciFixRounds: 1 },
    next: "bad-review",
    effect: { stop: "error", reason: BAD_REVIEW },
  },
];

export { FIX_EDGES };
