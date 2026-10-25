// Cancellation controls the real owned process, never an invented issue
// stop or task result. Failed probes retain their actual files.
import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { BuddyOutcome, Machine } from "./buddy-flow-test-kit.ts";
import { machine } from "./buddy-flow-test-kit.ts";

const NO_AUTOMATIC_STOP = 9999;
const START_TIMEOUT_MS = 30_000;
const CHECK_MS = 100;

async function observedIssueRead(
  box: Machine,
  deadline: number,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  if (
    box
      .calls()
      .some((call) => call.args.some((arg) => arg.includes("/issues?")))
  ) {
    return true;
  }
  if (Date.now() >= deadline) {
    return false;
  }
  await delay(CHECK_MS, undefined, { signal });
  return await observedIssueRead(box, deadline, signal);
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
    const observed = await observedIssueRead(
      box,
      Date.now() + START_TIMEOUT_MS,
      signal,
    );
    assert(observed, "the actual buddy never reached its GitHub issue read");
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
