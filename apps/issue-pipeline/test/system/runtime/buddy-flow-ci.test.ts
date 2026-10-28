// An isolated regression for the final CI effect fence. The PR comes from
// the real Implement and its approval from Verify's records and review.
// Failed transport cannot turn parseable passing JSON into permission to
// merge.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RECORD } from "../../../src/tasks/records.ts";
import {
  callsOf,
  GATEKEEPER,
  implemented,
  landsOf,
  retainOnFailure,
  verified,
} from "./buddy-flow-land-test-kit.ts";
import { applyStart, ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

const PASS = JSON.stringify([
  { name: "required", state: "SUCCESS", bucket: "pass", link: null },
]);
const AUTH_EXIT = 4;
const ADMISSION_REPLIES = [
  {
    stdout: JSON.stringify([
      { name: "required", state: "PENDING", bucket: "pending" },
    ]),
    stderr: "",
    code: 8,
  },
  { stdout: "{", stderr: "", code: 0 },
  { stdout: "[]", stderr: "no required checks reported", code: 1 },
];
// One admission hold per reply, one failed Land, then the stop.
const GATEKEEPER_POLLS: number = ADMISSION_REPLIES.length + 2;
const CI_RACE_FAILED = /^nothing merged:.*unreadable/u;

test("Land rejects passing CI JSON from a failed transport at its actual effect", async ({
  signal,
}) => {
  const box = machine(undefined, { landPermission: true });
  let passed = false;
  try {
    const target = box.git(["rev-parse", "refs/heads/main"]);
    const head = await implemented(box, signal);
    verified(box, head, "passed");

    // Real admission reads first see pending, malformed and absent CI.
    // None may begin a Land. Once these are exhausted, passing CI admits
    // it and only its real attempt activates the effect transport failure;
    // passing JSON still must not permit the merge.
    box.change((world) => {
      world.checks = { [head]: [{ name: "required", bucket: "pass" }] };
      world.checksSequence = structuredClone(ADMISSION_REPLIES);
      world.checksReply = {
        stdout: PASS,
        stderr: "authentication failed",
        code: AUTH_EXIT,
        afterComment: ['"kind":"attempt"', '"task":"land"'],
      };
    });
    applyStart(box, "start:land");
    const run = await box.runBuddy([], GATEKEEPER_POLLS, GATEKEEPER, signal);
    signal.throwIfAborted();
    assert.equal(run.status, 0, run.stderr);
    // A premature attempt activates the effect fault and leaves admission
    // replies unconsumed. Exactly one attempt after an empty queue proves
    // all three earlier replies held without spending this binding.
    assert.deepEqual(box.world().checksSequence, []);
    assert.equal(landsOf(run).length, 1);
    const land = marked(box.world(), "task-result", ISSUE)
      .map((row) => RECORD.parse(row))
      .filter((row) => row.binding.task === "land");
    assert.equal(land.length, 2, JSON.stringify(run.actions));
    const attempt = land.find((row) => row.kind === "attempt");
    const result = land.find((row) => row.kind === "result");
    assert(attempt !== undefined);
    assert(result?.kind === "result");
    assert.equal(result.verdict, "failed");
    assert.match(result.receipt.summary, CI_RACE_FAILED);
    assert.deepEqual(result.run, attempt.run);
    assert.deepEqual(result.binding, attempt.binding);
    assert.equal(box.git(["rev-parse", "refs/heads/main"]), target);
    assert.deepEqual(callsOf(box, ["pr", "merge"]), []);
    passed = true;
  } finally {
    retainOnFailure(box, passed, "CI guard");
  }
});
