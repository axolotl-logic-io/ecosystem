// @ts-check
// Every edge of the implementor's `checks` entry (#420; the wiki's
// Pipeline-Roles-Implementor, "Entry `checks`"), with the start's edge into
// it, up to its CI fixer (implementor-checks-fix-edge-fixtures.mjs has the
// rest): a state, a result, the reply and data it is taken with, the next
// state, its effect (an op's, check's or session's name, an end, or a stop
// as its code and reason) and the data it changes. The limits are the
// table's own (LIMITS: maxCiFixes 2, maxContinuations 1).
import { outOfRoomReason } from "../src/workflow/stages/continuation.ts";
import {
  CI_FAILURE,
  CI_MOVED,
  fixLimit,
  HEAD,
  NO_CI,
  VERIFY_FAILURE,
  VERIFY_MOVED,
  WIKI_ONLY_SUMMARY,
} from "./implementor-checks-test-kit.mjs";

/** @import { End } from "../src/roles/machine.ts" */

/**
 * A stop, as the edges pin it: its code and the reason its stop op posts.
 * @typedef {{ stop: string, reason: string }} Stop
 */

/**
 * @typedef {object} ChecksEdge
 * @property {string} at
 * @property {string} result
 * @property {unknown} [reply]
 * @property {Record<string, unknown>} [data]
 * @property {string} next
 * @property {string | End | Stop} effect
 * @property {Record<string, unknown>} [changes]
 */

const AT_LIMIT = { ciFixRounds: 2, maxCiFixes: 2 };
// One continuation, as LIMITS and the test config allow.
const OUT_OF_ROOM = outOfRoomReason("CI fixer", 1);

/** @type {ChecksEdge[]} */
const CHECKS_EDGES = [
  {
    at: "start",
    result: "checks",
    next: "checks-work?",
    effect: "check:checks-work?",
  },
  {
    at: "checks-work?",
    result: "verified",
    next: "ci-status",
    effect: "check:ci-status",
  },
  {
    at: "checks-work?",
    result: "work",
    next: "wiki-check",
    effect: "check:wiki-check",
  },
  { at: "wiki-check", result: "pass", next: "verify", effect: "check:verify" },
  {
    at: "wiki-check",
    result: "wiki-only",
    data: { testsOnly: false, flows: { code: false, wiki: true } },
    next: "checked",
    effect: { kind: "saved", stage: "accept" },
    changes: {
      verifiedSha: HEAD,
      verifySummary: WIKI_ONLY_SUMMARY,
      testsOnly: false,
      rebasedOnly: false,
    },
  },
  {
    at: "wiki-check",
    result: "wiki-only",
    data: { testsOnly: true, flows: { code: false, wiki: true } },
    next: "checked",
    effect: { kind: "saved", stage: "merge" },
    changes: { testsOnly: false, rebasedOnly: true },
  },
  {
    at: "wiki-check",
    result: "fail",
    reply: { failure: VERIFY_FAILURE },
    data: { ciFixRounds: 0 },
    next: "ci-fixer",
    effect: "session:cifix-1",
    changes: { ciFixRounds: 1, failure: VERIFY_FAILURE, fix: null },
  },
  {
    at: "wiki-check",
    result: "fail",
    reply: { failure: VERIFY_FAILURE },
    data: AT_LIMIT,
    next: "fix-limit",
    effect: { stop: "check-fixes", reason: fixLimit(2) },
  },
  {
    at: "verify",
    result: "pass",
    reply: { headSha: HEAD, summary: "lint: ok; test: 12 passed" },
    next: "ci-status",
    effect: "check:ci-status",
    changes: { verifiedSha: HEAD, verifySummary: "lint: ok; test: 12 passed" },
  },
  {
    at: "verify",
    result: "fail",
    reply: { failure: VERIFY_FAILURE },
    data: { ciFixRounds: 0 },
    next: "ci-fixer",
    effect: "session:cifix-1",
    changes: { ciFixRounds: 1, failure: VERIFY_FAILURE },
  },
  {
    at: "verify",
    result: "fail",
    reply: { failure: VERIFY_FAILURE },
    data: AT_LIMIT,
    next: "fix-limit",
    effect: { stop: "check-fixes", reason: fixLimit(2) },
    changes: { ciFixRounds: 2 },
  },
  {
    at: "verify",
    result: "moved",
    next: "verify-moved",
    effect: { stop: "branch-changed", reason: VERIFY_MOVED },
  },
  {
    at: "ci-status",
    result: "green",
    data: { testsOnly: false, verifiedSha: HEAD },
    next: "checked",
    effect: { kind: "saved", stage: "accept" },
    changes: { rebasedOnly: false, testsOnly: false, verifiedSha: HEAD },
  },
  {
    at: "ci-status",
    result: "green",
    data: { testsOnly: true },
    next: "checked",
    effect: { kind: "saved", stage: "merge" },
    changes: { rebasedOnly: true, testsOnly: false },
  },
  {
    at: "ci-status",
    result: "pending",
    data: { verifiedSha: HEAD },
    next: "ci-pending",
    effect: { kind: "held" },
    changes: { verifiedSha: HEAD },
  },
  {
    at: "ci-status",
    result: "fail",
    reply: { failure: CI_FAILURE },
    data: { ciFixRounds: 1 },
    next: "ci-fixer",
    effect: "session:cifix-2",
    changes: { ciFixRounds: 2, failure: CI_FAILURE, fix: null },
  },
  {
    at: "ci-status",
    result: "fail",
    reply: { failure: CI_FAILURE },
    data: AT_LIMIT,
    next: "fix-limit",
    effect: { stop: "check-fixes", reason: fixLimit(2) },
  },
  {
    at: "ci-status",
    result: "moved",
    next: "ci-moved",
    effect: { stop: "branch-changed", reason: CI_MOVED },
  },
  {
    at: "ci-status",
    result: "no-checks",
    next: "no-ci",
    effect: { stop: "no-ci", reason: NO_CI },
  },
];

export { AT_LIMIT, CHECKS_EDGES, OUT_OF_ROOM };
