// @ts-check
// The finalizer role restarted (#416): a run killed at any call and started
// again from the saved state, as the claim would start it, ends as an
// uninterrupted one and merges the PR on GitHub once; and an issue saved
// at merge by today's stage code, mid-wiki included, whose PR GitHub already
// shows merged, gets the bookkeeping with no second merge.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  finalize,
  killedFinalize,
  MERGED_LABEL,
  prMerges,
  sentTo,
} from "./finalizer-role-test-kit.mjs";

/** @type {readonly ("before" | "after")[]} */
const KILL_POINTS = ["before", "after"];
// The merge stage's phases an old state may be saved at mid-wiki
// (src/workflow/stages/merge.ts).
const OLD_PHASES = ["begin", "wiki-synced", "resolved", "wiki-checked"];

const CLEAN = {};
const WIKI_CONFLICT = { wiki: true, wikiConflict: true };
// More effect calls than either scenario's uninterrupted run makes, saves
// included, so killing at each of them covers every call.
const KILL_CALLS = 12;

/** @typedef {Awaited<ReturnType<typeof finalize>>} FinalizerRun */

/** @type {Map<object, Promise<FinalizerRun>>} */
const references = new Map();

/** @param {object} setup @returns {Promise<FinalizerRun>} the scenario's uninterrupted run, made once */
function referenceOf(setup) {
  const made = references.get(setup) ?? finalize(setup);
  references.set(setup, made);
  return made;
}

const SCENARIOS = [
  { name: "clean merge", setup: CLEAN },
  { name: "wiki conflict", setup: WIKI_CONFLICT },
];

for (const { name, setup } of SCENARIOS) {
  test(`a ${name} reaches done and merges once when never killed`, async () => {
    const reference = await referenceOf(setup);
    assert.deepEqual(reference.end, { kind: "saved", stage: "done" });
    assert.equal(prMerges(reference.writes), 1);
    assert.ok(reference.calls.length <= KILL_CALLS, "KILL_CALLS is too low");
  });
  for (let k = 1; k <= KILL_CALLS; k += 1) {
    for (const when of KILL_POINTS) {
      test(`a ${name} killed ${when} call ${k} ends as an uninterrupted one, merging once`, async () => {
        const reference = await referenceOf(setup);
        const run = await killedFinalize({ k, when }, setup);
        // A run the claim wouldn't start again has no end of its own.
        const end =
          run.end === "killed" || isDeepStrictEqual(run.end, reference.end);
        assert.ok(end, JSON.stringify(run.end));
        const { stage } = run.saved;
        assert.equal(stage, reference.saved.stage);
        assert.deepEqual(run.labels, reference.labels);
        assert.equal(prMerges(run.writes), 1);
      });
    }
  }
}

test("a restart after the PR merged finishes the bookkeeping without merging again", async () => {
  const run = await finalize({ prMerged: true });
  assert.deepEqual(run.end, { kind: "saved", stage: "done" });
  assert.equal(prMerges(run.writes), 0);
  assert.equal(sentTo(run, "merge").length, 1);
  assert.deepEqual(run.labels, [MERGED_LABEL]);
});

for (const phase of OLD_PHASES) {
  test(`an issue saved at merge by the stage code at phase ${phase} resumes in the role`, async () => {
    const run = await finalize({
      wiki: true,
      prMerged: true,
      start: { phase, carry: null },
    });
    assert.deepEqual(run.end, { kind: "saved", stage: "done" });
    assert.equal(prMerges(run.writes), 0);
    assert.deepEqual(run.labels, [MERGED_LABEL]);
  });
}
