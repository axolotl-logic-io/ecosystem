// @ts-check
// What the pipeline does with each triage decision on an issue (depth 0) and
// on a sub-issue (depth 1), as the triage role's reply module reads it (#304):
// a sub-issue's split, and questions with none asked, read as a reject.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionOf } from "../src/roles/triage/reply.ts";

/** @import { TriageDecision, TriageReply } from "../src/roles/triage/reply.ts" */

/**
 * @typedef {object} Case
 * @property {TriageDecision} decision the agent's decision
 * @property {string[]} questions the questions it asked
 * @property {number} depth 0 for an issue, 1 for a sub-issue
 * @property {TriageDecision} expected what the pipeline does
 */

const ASKED = ["Which page?"];

/** @type {Case[]} */
const CASES = [
  { decision: "ready", questions: [], depth: 0, expected: "ready" },
  { decision: "ready", questions: [], depth: 1, expected: "ready" },
  { decision: "split", questions: [], depth: 0, expected: "split" },
  { decision: "split", questions: [], depth: 1, expected: "reject" },
  { decision: "reject", questions: [], depth: 0, expected: "reject" },
  { decision: "reject", questions: [], depth: 1, expected: "reject" },
  {
    decision: "needs-info",
    questions: ASKED,
    depth: 0,
    expected: "needs-info",
  },
  {
    decision: "needs-info",
    questions: ASKED,
    depth: 1,
    expected: "needs-info",
  },
  { decision: "needs-info", questions: [], depth: 0, expected: "reject" },
  { decision: "needs-info", questions: [], depth: 1, expected: "reject" },
];

/** @param {Case} entry @returns {TriageReply} the reply the agent gave */
function replyOf(entry) {
  const { decision, questions } = entry;
  return { decision, reason: "Because.", questions, plan: "" };
}

for (const entry of CASES) {
  const { decision, questions, depth, expected } = entry;
  const asked = `${questions.length} questions`;
  test(`a ${decision} with ${asked} at depth ${depth} reads as ${expected}`, () => {
    assert.equal(decisionOf(replyOf(entry), depth), expected);
  });
}
