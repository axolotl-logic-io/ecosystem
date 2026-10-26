// Cancellation controls the real owned process, never an invented issue
// stop or task result. Failed probes retain their actual files.
import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import type { BuddyOutcome, Machine } from "./buddy-flow-test-kit.ts";
import { machine } from "./buddy-flow-test-kit.ts";

const NO_AUTOMATIC_STOP = 9999;
// Whether the buddy has read the repository's issues on GitHub.
function observedIssueRead(box: Machine): boolean {
  return box
    .calls()
    .some((call) => call.args.some((arg) => arg.includes("/issues?")));
}

test("fixture cancellation stops only its owned public buddy without creating issue authority", async ({
  signal,
}) => {
  const box = machine((world) => {
    world.issues = [];
  });
  const stop = new AbortController();
  let running: Promise<BuddyOutcome> | undefined;
  let accepted = false;
  try {
    running = box.runBuddy(
      [],
      NO_AUTOMATIC_STOP,
      undefined,
      AbortSignal.any([signal, stop.signal]),
    );
    // Fails the test when the buddy never reaches its GitHub issue read.
    await box.when(() => observedIssueRead(box), { signal });
    stop.abort();
    const run = await running;
    signal.throwIfAborted();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.ended.kind, "stopped");
    assert.deepEqual(run.actions, []);
    assert.deepEqual(box.world().issues, []);
    assert.deepEqual(box.launches(), []);
    accepted = true;
  } finally {
    stop.abort();
    await running?.catch(() => undefined);
    if (accepted && !signal.aborted) {
      box.cleanup();
    } else {
      process.stderr.write(`Cancellation fixture retained: ${box.root}\n`);
    }
  }
});
