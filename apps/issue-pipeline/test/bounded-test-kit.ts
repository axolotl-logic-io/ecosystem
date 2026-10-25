// The tests' bounds: what a test starts ends with it, and what it waits for
// has a deadline (`pipeline-tests-bounded`, #372). A cleanup
// passed to `endsWithTest` runs once the test that registered it ends,
// whether it passed, failed or timed out; and `waitFor` rejects, naming what
// it waited for, when its condition hasn't held by its deadline, so a missed
// event fails before the test timeout. `pidIn` reads the pid a started
// process wrote to a file, once its line is whole, for the test to wait on.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { afterEach } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// How often waitFor looks at its condition again.
const POLL_MS = 20;
// waitFor's default deadline. It covers a stage job reaching a marker it
// writes, such as its session's launch or usage in job.json, the steer socket
// or pi's prompt. The slowest such wait measured was 5.4 s (the session's
// spending, in job-checkout-layout.test.ts), in a full `node --test` run
// beside three more in a copy of the checkout, at 1-minute load averages of
// up to 130 on 10 cores (2026-10-17). It is over 3 times that, and below the
// per-test timeout (`--test-timeout` in package.json's check scripts), so a
// missed marker fails naming itself first.
const WAIT_MS = 20_000;

type Cleanup = () => unknown;

// the current test's cleanups, oldest first
const cleanups: Cleanup[] = [];

// Runs each of `stops` in turn, every one even if an earlier one throws.
// Returns what each that threw threw
async function runEach(stops: readonly Cleanup[]): Promise<unknown[]> {
  const [stop, ...rest] = stops;
  if (stop === undefined) {
    return [];
  }
  const thrown: unknown[] = [];
  try {
    await stop();
  } catch (error) {
    thrown.push(error);
  }
  return [...thrown, ...(await runEach(rest))];
}

// Node runs a top-level afterEach after each test of the file, even one that
// failed or timed out.
afterEach(async () => {
  const thrown = await runEach(cleanups.splice(0).reverse());
  if (thrown.length > 0) {
    throw new AggregateError(thrown, "a test's cleanup failed");
  }
});

// Runs `stop` once the current test ends, before the cleanups registered
// earlier in it.
function endsWithTest(stop: Cleanup): void {
  cleanups.push(stop);
}

// Resolves once `check` holds, looking again every POLL_MS, or rejects
// naming `what` once `deadline` (a `performance.now()` time) has passed.
async function pollUntil(
  what: string,
  check: () => boolean,
  deadline: number,
): Promise<void> {
  if (check()) {
    return;
  }
  if (performance.now() >= deadline) {
    throw new Error(`waitFor: ${what} didn't happen in time`);
  }
  await delay(POLL_MS);
  await pollUntil(what, check, deadline);
}

// Resolves once `check` holds; rejects, naming `what`, if it hasn't held
// within `withinMs`.
// what: the condition, as the error names it
function waitFor(
  what: string,
  check: () => boolean,
  withinMs: number = WAIT_MS,
): Promise<void> {
  return pollUntil(what, check, performance.now() + withinMs);
}

// Returns whether the process is running
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// SIGKILLs the process group `pid` leads, if it is still there.
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: that group has ended.
  }
}

// The pid in `dir`'s file `name`, once its line is written, else null.
function pidIn(dir: string, name: string): number | null {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    return null;
  }
  const text = fs.readFileSync(file, "utf8");
  if (!text.endsWith("\n")) {
    return null;
  }
  return Number(text);
}

export { alive, endsWithTest, killGroup, pidIn, waitFor };
