// @ts-check
// The orchestrator's escalations (#235): an open issue with a stop the
// watchdog's rules didn't expect, an acceptance fail or agent:needs-info is
// written to runs/<slug>/escalations.jsonl and logged, once while it carries
// the label; the job stop the rules end in is not escalated, and a budget
// stop, which no rule settles, is.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { loggedFor, tickOver } from "./orchestrator-watchdog-test-kit.mjs";
import { runFile } from "./orchestrator-world-test-kit.mjs";

const ISSUE = {
  acceptance: 80,
  needsInfo: 81,
  conflict: 82,
  job: 83,
  budget: 84,
  again: 85,
};
const ESCALATION = z.object({
  at: z.string(),
  issue: z.number(),
  stage: z.string(),
  reason: z.string(),
  label: z.string(),
});

/** @param {number} issue @returns {z.infer<typeof ESCALATION>[]} */
function escalationsOf(issue) {
  const file = runFile("escalations.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => ESCALATION.parse(JSON.parse(line)))
    .filter((line) => line.issue === issue);
}

/** @param {number} issue @returns {string[]} */
function reasonsOf(issue) {
  return escalationsOf(issue).map(({ reason, label }) => `${reason} ${label}`);
}

const STOPPED = { stage: "stopped" };
const ISSUES = [
  {
    number: ISSUE.acceptance,
    labels: ["agent:stopped-acceptance"],
    state: STOPPED,
  },
  { number: ISSUE.needsInfo, labels: ["agent:needs-info"] },
  {
    number: ISSUE.conflict,
    labels: ["agent:stopped-conflict"],
    state: STOPPED,
  },
  { number: ISSUE.job, labels: ["agent:stopped-job"], state: STOPPED },
  { number: ISSUE.budget, labels: ["agent:stopped-budget"], state: STOPPED },
];

test("an acceptance fail, a needs-info and unexpected stops are escalated once each; a job stop is not", () => {
  tickOver(ISSUES);
  tickOver(ISSUES);
  assert.deepEqual(reasonsOf(ISSUE.acceptance), [
    "acceptance-fail agent:stopped-acceptance",
  ]);
  assert.deepEqual(reasonsOf(ISSUE.needsInfo), ["needs-info agent:needs-info"]);
  assert.deepEqual(reasonsOf(ISSUE.conflict), [
    "unexpected-stop agent:stopped-conflict",
  ]);
  assert.deepEqual(reasonsOf(ISSUE.job), []);
  assert.deepEqual(reasonsOf(ISSUE.budget), [
    "unexpected-stop agent:stopped-budget",
  ]);
  assert.deepEqual(escalationsOf(ISSUE.acceptance)[0]?.stage, "stopped");
  assert.deepEqual(
    loggedFor(ISSUE.conflict).map(
      ({ action, reason }) => `${action} ${reason}`,
    ),
    ["escalated unexpected-stop"],
  );
});

test("a label that is removed and comes back is escalated again", () => {
  const flagged = [{ number: ISSUE.again, labels: ["agent:needs-info"] }];
  tickOver(flagged);
  tickOver([{ number: ISSUE.again }]);
  tickOver(flagged);
  assert.deepEqual(reasonsOf(ISSUE.again), [
    "needs-info agent:needs-info",
    "needs-info agent:needs-info",
  ]);
});
