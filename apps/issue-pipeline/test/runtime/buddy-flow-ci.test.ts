// An isolated regression for the final CI effect fence. Every prerequisite
// comes from actual tasks, not seeded records. Failed transport cannot turn
// parseable passing JSON into permission to move the target.
import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import type { TaskRecord } from "../../src/tasks/records.ts";
import { RECORD } from "../../src/tasks/records.ts";
import type { Machine, PlannedSession } from "./buddy-flow-test-kit.ts";
import { ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

const PRECONDITION_POLLS = 3;
const PREREQUISITES = ["implement", "harden", "integrate", "review-security"];
const IMPLEMENT: PlannedSession = {
  commit: {
    file: "counter.txt",
    content: "3 widgets\n",
    message: "Count widgets",
  },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted widgets." },
};
const HARDEN: PlannedSession = {
  ...IMPLEMENT,
  commit: {
    file: "counter.txt",
    content: "3 checked widgets\n",
    message: "Check widget count",
  },
  reply: { outcome: "done", summary: "Checked widgets." },
};
const SECURITY: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { summary: "No security finding.", finding: null },
};
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
// Integrate, Security, one failed Land, then stop, plus admission holds.
const GATEKEEPER_POLLS = 4;
const OBSERVATION_POLLS: number = ADMISSION_REPLIES.length + GATEKEEPER_POLLS;
const CI_RACE_FAILED = /nothing landed:.*unreadable/u;

function records(box: Machine): TaskRecord[] {
  return marked(box.world(), "task-result").map((row) => RECORD.parse(row));
}

test("Land rejects passing CI JSON from a failed transport at its actual effect", async ({
  signal,
}) => {
  const box = machine(undefined, { landPermission: true });
  let passed = false;
  try {
    const target = box.git(["rev-parse", "refs/heads/main"]);
    const developer = await box.runBuddy(
      [IMPLEMENT, HARDEN],
      PRECONDITION_POLLS,
      { role: "developer", tasks: ["implement", "harden"] },
      signal,
    );
    signal.throwIfAborted();
    assert.equal(developer.status, 0, developer.stderr);
    const code = box.git(["rev-parse", `refs/heads/agent/issue-${ISSUE}`]);
    assert.notEqual(code, target);
    assert.deepEqual(box.checksRun(), []);

    // Real admission reads first see pending, malformed and absent CI.
    // None may begin a Land. Once these are exhausted,
    // passing CI admits it and only its real attempt activates the effect
    // transport failure; passing JSON still must not permit the push.
    box.change((world) => {
      world.checks = { [code]: [{ name: "required", bucket: "pass" }] };
      world.checksSequence = structuredClone(ADMISSION_REPLIES);
      world.checksReply = {
        stdout: PASS,
        stderr: "authentication failed",
        code: AUTH_EXIT,
        afterComment: ['"kind":"attempt"', '"task":"land"'],
      };
    });
    const run = await box.runBuddy(
      [SECURITY],
      OBSERVATION_POLLS,
      { role: "gatekeeper", tasks: ["integrate", "review-security", "land"] },
      signal,
    );
    signal.throwIfAborted();
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      records(box)
        .filter((row) => row.kind === "result" && row.verdict === "passed")
        .map((row) => row.binding.task),
      PREREQUISITES,
    );
    // A premature attempt activates the effect fault and leaves admission
    // replies unconsumed. Exactly one attempt after an empty queue proves
    // all three earlier replies held without spending this binding.
    assert.deepEqual(box.world().checksSequence, []);
    const land = records(box).filter((row) => row.binding.task === "land");
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
    assert.deepEqual(box.checksRun(), [code]);
    assert.equal(box.launches().length, PREREQUISITES.length - 1);
    passed = true;
  } finally {
    if (passed) {
      box.cleanup();
    } else {
      process.stderr.write(`CI guard fixture retained: ${box.root}\n`);
    }
  }
});
