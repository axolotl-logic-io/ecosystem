// @ts-check
// A linear role's walk (src/roles/walk.ts): its steps run in order, a step
// whose `skip` holds is passed over, at the start or after another step, and
// a step whose `again` holds runs once more before the run goes on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { linearWalk } from "../src/roles/walk.ts";
import { roleContext } from "./role-context-fixtures.mjs";

/** @import { LinearScript, LinearStep, Position } from "../src/roles/walk.ts" */
/** @import { State } from "../src/state.ts" */

/** @typedef {{ skipFirst: boolean, skipMiddle: boolean, rounds: number, again: number }} WalkData */

/** @type {State} */
const SAVED = { stage: "merge" };
const OK = { name: "ok", reply: null };

/** @param {string} name @param {Partial<LinearStep<WalkData>>} [more] @returns {LinearStep<WalkData>} */
function step(name, more = {}) {
  return {
    name,
    kind: "script",
    effect: () => ({ kind: "op", op: name, payload: {} }),
    ...more,
  };
}

/** @param {WalkData} data @returns {LinearScript<WalkData>} */
function scriptOf(data) {
  return {
    locate: () => ({ at: "first", data }),
    steps: [
      step("first", { skip: (d) => d.skipFirst }),
      step("middle", { skip: (d) => d.skipMiddle }),
      step("repeat", {
        apply: (d) => ({ ...d, rounds: d.rounds + 1 }),
        again: (d) => d.rounds < d.again,
      }),
      step("last"),
    ],
    end: () => ({ kind: "saved", stage: "done" }),
    handoff: [],
    checkpoints: [],
  };
}

/**
 * The step names a walk of `data`'s script reaches, in order, to its end.
 * @param {Partial<WalkData>} fields @returns {string[]}
 */
function walked(fields) {
  /** @type {WalkData} */
  const data = {
    skipFirst: false,
    skipMiddle: false,
    rounds: 0,
    again: 0,
    ...fields,
  };
  const walk = linearWalk(scriptOf(data));
  /** @type {Position<string, WalkData>} */
  let at = walk.start(SAVED, roleContext());
  const names = [at.at];
  while (at.kind !== "end") {
    at = walk.next(at, OK);
    names.push(at.at);
  }
  return names;
}

test("a linear walk runs every step in order with none skipped or repeated", () => {
  assert.deepEqual(walked({}), ["first", "middle", "repeat", "last", "end"]);
});

test("a skipped step is passed over, at the start and after another step", () => {
  assert.deepEqual(walked({ skipFirst: true }), [
    "middle",
    "repeat",
    "last",
    "end",
  ]);
  assert.deepEqual(walked({ skipMiddle: true }), [
    "first",
    "repeat",
    "last",
    "end",
  ]);
});

test("a step runs again while its again holds, then the walk goes on", () => {
  const repeats = ["repeat", "repeat", "repeat"];
  assert.deepEqual(walked({ skipFirst: true, skipMiddle: true, again: 3 }), [
    ...repeats,
    "last",
    "end",
  ]);
});
