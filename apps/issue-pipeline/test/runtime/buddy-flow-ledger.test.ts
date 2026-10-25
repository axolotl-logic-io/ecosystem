// The actual ledger must confirm the privacy-safe body it posts, while
// keeping the authenticated attempt, subject and producer unchanged.
import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { RECORD } from "../../src/tasks/records.ts";
import type { PlannedSession } from "./buddy-flow-test-kit.ts";
import { ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

const POLLS = 3;

test("a built buddy confirms a result whose private diagnostic was redacted", async ({
  signal,
}) => {
  const box = machine();
  let accepted = false;
  try {
    const summary = `Implemented at ${box.pipeline}/private/checkout using 127.0.0.1.`;
    const session: PlannedSession = {
      commit: {
        file: "counter.txt",
        content: "3 widgets\n",
        message: "Count the widgets",
      },
      change: null,
      changeFirst: false,
      awaitAbort: false,
      reply: { outcome: "done", summary },
    };
    const run = await box.runBuddy([session], POLLS, undefined, signal);
    signal.throwIfAborted();
    assert.equal(run.status, 0, run.stderr);
    const action = run.actions.find((row) => row.task === "implement");
    assert(action !== undefined, JSON.stringify(run.actions));
    assert.equal(action.verdict, "passed", JSON.stringify(run.actions));
    assert.equal(action.ownership.state, "released");

    const records = marked(box.world(), "task-result").map((row) =>
      RECORD.parse(row),
    );
    assert.equal(records.length, 2);
    const attempt = records.find((row) => row.kind === "attempt");
    const result = records.find((row) => row.kind === "result");
    assert(attempt !== undefined);
    assert(result?.kind === "result");
    assert.equal(result.verdict, "passed");
    assert.deepEqual(result.binding, attempt.binding);
    assert.deepEqual(result.run, attempt.run);
    assert.deepEqual(result.cause, attempt.cause);
    assert.equal(result.buddyRun, attempt.buddyRun);
    assert.equal(result.run.id, action.id);
    assert.equal(
      result.receipt.produced?.code,
      box.git(["rev-parse", `refs/heads/agent/issue-${ISSUE}`]),
    );
    assert(!result.receipt.summary.includes(box.pipeline));
    assert(!result.receipt.summary.includes("127.0.0.1"));
    assert(result.receipt.summary.includes("$ISSUE_PIPELINE_ROOT"));
    assert.equal(action.reason, summary);
    accepted = true;
  } finally {
    if (accepted && !signal.aborted) {
      box.cleanup();
    } else {
      process.stderr.write(`Ledger regression fixture retained: ${box.root}\n`);
    }
  }
});
