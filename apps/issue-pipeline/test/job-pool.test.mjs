// The stage job's bounded pool: never more than its limit running at once,
// and the results in the items' order whatever order they finish in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runAll } from "../src/job/pool.ts";

// The default spawn cap, far above these batches.
const SPAWN_CAP = 64;

// A run whose items each wait on a deferred promise the test settles, and
// which records how many were running at the most.
/**
 * @returns {{ finish: (item: string) => void, started: string[], run: (item: string) => Promise<string>, most: () => number }}
 */
function deferredRuns() {
  /** @type {Map<string, () => void>} */
  const pending = new Map();
  /** @type {string[]} */
  const started = [];
  let running = 0;
  let most = 0;
  /** @param {string} item @returns {Promise<string>} */
  function run(item) {
    running += 1;
    most = Math.max(most, running);
    started.push(item);
    return new Promise((resolve) => {
      pending.set(item, () => {
        running -= 1;
        resolve(`done ${item}`);
      });
    });
  }
  /** @param {string} item @returns {void} */
  function finish(item) {
    const resolve = pending.get(item);
    if (resolve === undefined) {
      throw new Error(`${item} is not running`);
    }
    resolve();
  }
  return { finish, started, run, most: () => most };
}

// Lets every pending promise continuation run: setImmediate's callback
// runs only once the microtask queue is empty.
/** @returns {Promise<void>} */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("the pool runs at most its limit at once and returns results in order", async () => {
  const runs = deferredRuns();
  const all = runAll(["a", "b", "c", "d", "e"], 2, runs.run);
  await settle();
  assert.deepEqual(runs.started, ["a", "b"]);
  runs.finish("b");
  await settle();
  assert.deepEqual(runs.started, ["a", "b", "c"]);
  runs.finish("a");
  await settle();
  assert.deepEqual(runs.started, ["a", "b", "c", "d"]);
  runs.finish("c");
  await settle();
  assert.deepEqual(runs.started, ["a", "b", "c", "d", "e"]);
  runs.finish("e");
  runs.finish("d");
  assert.deepEqual(await all, [
    "done a",
    "done b",
    "done c",
    "done d",
    "done e",
  ]);
  assert.equal(runs.most(), 2);
});

test("a limit above the batch size runs the whole batch at once", async () => {
  const runs = deferredRuns();
  const all = runAll(["x", "y", "z"], SPAWN_CAP, runs.run);
  await settle();
  assert.deepEqual(runs.started, ["x", "y", "z"]);
  for (const item of ["z", "y", "x"]) {
    runs.finish(item);
  }
  assert.deepEqual(await all, ["done x", "done y", "done z"]);
});

test("an empty batch resolves to no results", async () => {
  assert.deepEqual(await runAll([], SPAWN_CAP, () => Promise.resolve("")), []);
});
