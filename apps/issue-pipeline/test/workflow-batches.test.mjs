// @ts-check
// driveBatches runs the batches a sweep's driver asks for, one after another,
// feeding each batch's results back, until the driver asks for none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { driveBatches } from "../src/workflow/batches.ts";

/** @typedef {import("../src/workflow/launches.ts").LaunchSpec} LaunchSpec */

// How long a fake launch may run, which nothing here waits for.
const TIMEOUT_MS = 1000;

// An ops launch spec named `name`.
/** @param {string} name @returns {LaunchSpec} */
function spec(name) {
  return {
    key: name,
    label: name,
    agent: name,
    task: name,
    timeoutMs: TIMEOUT_MS,
    control: { needsAttentionAfterMs: TIMEOUT_MS },
  };
}

// A driver that asks for `batches` in order, then for none, and records the
// results it is fed.
/** @param {LaunchSpec[][]} batches */
function fakeSweep(batches) {
  /** @type {(readonly unknown[])[]} */
  const fed = [];
  const queue = [...batches];
  return {
    fed,
    /** @param {readonly unknown[]} raw @returns {LaunchSpec[]} */
    next(raw) {
      fed.push(raw);
      return queue.shift() ?? [];
    },
    summary() {
      throw new Error("driveBatches never reads the summary");
    },
  };
}

test("driveBatches runs each batch in turn and feeds its results back", async () => {
  const sweep = fakeSweep([[spec("a"), spec("b")], [spec("c")]]);
  /** @type {string[][]} */
  const ran = [];
  await driveBatches(sweep, (specs) => {
    ran.push(specs.map((one) => one.agent));
    return Promise.resolve(specs.map((one) => `${one.agent} done`));
  });
  assert.deepEqual(ran, [["a", "b"], ["c"]]);
  assert.deepEqual(sweep.fed, [[], ["a done", "b done"], ["c done"]]);
});

test("driveBatches runs nothing when the driver asks for no batch", async () => {
  const sweep = fakeSweep([]);
  let runs = 0;
  await driveBatches(sweep, () => {
    runs += 1;
    return Promise.resolve([]);
  });
  assert.equal(runs, 0);
  assert.deepEqual(sweep.fed, [[]]);
});
