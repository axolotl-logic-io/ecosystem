// @ts-check
// The reviewer role's machine for issue #7 (#421): a state today's `review`
// stage saved, the data locate builds from it, the prepare check's reply and
// a step through `transition`.
import { locate } from "../src/roles/reviewer/locate.ts";
import { transition } from "../src/roles/reviewer/machine.ts";
import { roleContext } from "./role-context-fixtures.mjs";

/** @import { State } from "../src/state.ts" */
/** @import { Effect, End, SessionEffect, Step } from "../src/roles/machine.ts" */
/** @import { ReviewerData, ReviewerState } from "../src/roles/reviewer/locate.ts" */
/** @import { ReviewerResult } from "../src/roles/reviewer/machine.ts" */

const PR = 42;
const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PATCH_ID = "f".repeat(HEAD.length);
const BUNDLE_TEXT = "Review bundle of #7: the diff and src/a.ts at the head.";

// A finding an earlier round numbered and the fixer resolved.
const RESOLVED = {
  id: "f2",
  file: "src/a.ts",
  line: 1,
  title: "Off by one",
  evidence: "It skips the last item.",
  suggestion: "Use <=.",
  lenses: ["correctness"],
  category: null,
  status: "resolved",
  disputed: false,
};

// Issue #7 as today's `review` stage saved it, between rounds: its PR,
// head, numbered findings and an earlier review's head and patch id.
/** @type {State} */
const OLD_REVIEW_STATE = {
  version: 1,
  number: 7,
  depth: 0,
  stage: "review",
  lease: null,
  pr: PR,
  headSha: "aaaaaaa",
  reviewedSha: "9999999",
  reviewedPatchId: "0".repeat(HEAD.length),
  plan: "Change src/a.ts and test it.",
  findings: [RESOLVED],
  nextFindingId: 2,
  round: 1,
  log: [],
};

// The prepare check's `ok` reply: prepare-review's reply, with the bundle's
// text.
const PREPARED = {
  ok: true,
  headSha: HEAD,
  headTree: "cccccccccccccccccccccccccccccccccccccccc",
  baseSha: "dddddddddddddddddddddddddddddddddddddddd",
  patchId: PATCH_ID,
  diffPath: "/runs/issue-7/diff.patch",
  diffLines: "3",
  changedFiles: ["src/a.ts"],
  bundlePath: "/runs/issue-7/bundle.md",
  bundleLines: 1,
  bundleText: BUNDLE_TEXT,
};

/** @returns {{ at: ReviewerState, data: ReviewerData }} where locate starts issue #7 at review */
function located() {
  return locate(OLD_REVIEW_STATE, roleContext());
}

/**
 * The step `result` (with `reply`) takes from `at`, from `data`.
 * @param {ReviewerState} at
 * @param {ReviewerResult} result
 * @param {unknown} [reply]
 * @param {ReviewerData} [data]
 * @returns {Step<ReviewerState, ReviewerData>}
 */
function stepFrom(at, result, reply = null, data = located().data) {
  return transition({ at, data }, { name: result, reply });
}

/** @returns {ReviewerData} the data once the prepare check replied */
function preparedData() {
  return stepFrom("prepare", "ok", PREPARED).state.data;
}

/**
 * An effect as the tests read it, whatever its kind: a check's name, an
 * end, the sessions of a sessions effect, or a session's name, agent,
 * model, schema and task.
 * @typedef {object} SeenEffect
 * @property {string} kind
 * @property {string} [check]
 * @property {End} [end]
 * @property {readonly SessionEffect[]} [sessions]
 * @property {string} [name]
 * @property {string} [agent]
 * @property {string} [model]
 * @property {unknown} [schema]
 * @property {string} [task]
 */

/** @param {Effect} effect @returns {SeenEffect} */
function seen(effect) {
  return effect;
}

export {
  BUNDLE_TEXT,
  HEAD,
  located,
  OLD_REVIEW_STATE,
  PATCH_ID,
  PR,
  PREPARED,
  preparedData,
  RESOLVED,
  seen,
  stepFrom,
};
