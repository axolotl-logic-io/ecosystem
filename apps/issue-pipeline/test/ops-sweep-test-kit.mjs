// @ts-check
// The sweep op's gh replies for the ops CLI tests: gh's replies to the reads
// every sweep begins with, and builders for the issue rows, leases,
// candidates and the sweep's reply.
import {
  ACCOUNT,
  ALLOWED,
  labelsReply,
  stateComment,
} from "./ops-cli-test-kit.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */

// The sweep's lane and id.
const LANE = { lane: "me", sweepId: "s1" };
const STATE_EXTRA = { pr: null };
// A candidate's priority by its kind; the sweep takes the lowest first.
const PRIORITY = { mine: -1, resume: 0, named: 0, answered: 1, new: 2 };
const DAY_DIGITS = 2;

/** @param {number} number @returns {string} */
function createdAt(number) {
  return `2026-10-${String(number).padStart(DAY_DIGITS, "0")}`;
}

/** @param {number} number @param {string[]} labels @param {object} [extra] @returns {object} */
function row(number, labels, extra = {}) {
  const named = labels.map((name) => ({ name }));
  const fields = { title: `Issue ${number}`, author: { login: ALLOWED } };
  return {
    number,
    ...fields,
    labels: named,
    createdAt: createdAt(number),
    body: "",
    ...extra,
  };
}

/** @param {readonly object[]} rows @param {readonly GhReply[]} [more] @returns {GhReply[]} */
function sweepReplies(rows, more = []) {
  return [
    { when: "api user", stdout: `${ACCOUNT}\n` },
    labelsReply,
    { when: "issue list", stdout: JSON.stringify(rows) },
    ...more,
  ];
}

/** @param {number} id @param {string} lane @param {string} at @returns {object} */
function leased(id, lane, at) {
  return stateComment(id, {
    stage: "implement",
    lease: { lane, sweepId: "x", at },
    ...STATE_EXTRA,
  });
}

/** @param {number} number @param {keyof typeof PRIORITY} kind @param {number} [depth] @returns {object} */
function candidate(number, kind, depth = 0) {
  const priority = PRIORITY[kind];
  return {
    number,
    title: `Issue ${number}`,
    kind,
    priority,
    createdAt: createdAt(number),
    depth,
  };
}

/** @param {object} extra @returns {object} */
function sweepReply(extra) {
  const counts = {
    posted: 0,
    waiting: 0,
    parents: [],
    liveElsewhere: 0,
    skipped: 0,
  };
  return { ok: true, op: "sweep", ...counts, ...extra };
}

export { candidate, LANE, leased, row, sweepReplies, sweepReply };
