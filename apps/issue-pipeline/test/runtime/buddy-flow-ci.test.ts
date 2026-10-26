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
const OBSERVATION_POLLS = 2;
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
    const reviewer = await box.runBuddy(
      [SECURITY],
      PRECONDITION_POLLS,
      { role: "gatekeeper", tasks: ["integrate", "review-security"] },
      signal,
    );
    signal.throwIfAborted();
    assert.equal(reviewer.status, 0, reviewer.stderr);
    assert.deepEqual(
      records(box)
        .filter((row) => row.kind === "result" && row.verdict === "passed")
        .map((row) => row.binding.task),
      PREREQUISITES,
    );
    const code = box.git(["rev-parse", `refs/heads/agent/issue-${ISSUE}`]);
    assert.notEqual(code, target);
    assert.deepEqual(box.checksRun(), [code]);

    // Admission sees passing CI. Only the real posted attempt activates
    // the transport failure; its passing JSON must not permit the push.
    box.change((world) => {
      world.checks = { [code]: [{ name: "required", bucket: "pass" }] };
      world.checksReply = {
        stdout: PASS,
        stderr: "authentication failed",
        code: AUTH_EXIT,
        afterComment: ['"kind":"attempt"', '"task":"land"'],
      };
    });
    const run = await box.runBuddy(
      [],
      OBSERVATION_POLLS,
      { role: "gatekeeper", tasks: ["land"] },
      signal,
    );
    signal.throwIfAborted();
    assert.equal(run.status, 0, run.stderr);
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
