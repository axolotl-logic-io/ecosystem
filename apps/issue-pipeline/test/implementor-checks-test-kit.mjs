// @ts-check
// The implementor role's `checks` entry for issue #7 (#420): its data as
// locate builds it from a state saved at checks, a step through
// `transition` from any of the entry's states, the CI fixer's and the
// check-fix reviewers' replies, and the stops the entry ends with.
import { locate } from "../src/roles/implementor/locate.ts";
import { TABLE, transition } from "../src/roles/implementor/machine.ts";
import { implContext, SPEC } from "./implementor-role-test-kit.mjs";

/** @import { State } from "../src/state.ts" */
/** @import { Effect, End, MachineState, Result, SessionEffect, Step } from "../src/roles/machine.ts" */
/** @import { RoleContext } from "../src/roles/walk.ts" */
/** @import { ImplData, ImplState } from "../src/roles/implementor/locate.ts" */
/** @import { ImplResult } from "../src/roles/implementor/machine.ts" */

// The head the claim gives, which the PR's review last reviewed.
const HEAD = "aaaaaaa";
// The head a CI fix's push reports.
const FIXED_HEAD = "bbbbbbb";
const PR = 42;
const CODE_FLOWS = { code: true, wiki: false };

// The CI fixer's replies (CIFIX_SCHEMA).
const FIXED = { status: "fixed", summary: "Fixed the lint error in src/a.ts." };
const HANDOFF_FIX = { status: "handoff", summary: "Half of the fix." };
const CANNOT_FIX = { status: "cannot-fix", summary: "The registry is down." };

// A blocking finding, and the check-fix reviewers' replies (REVIEW_SCHEMA).
const FINDING = {
  file: "src/a.ts",
  line: 3,
  title: "Drops the error",
  evidence: "The catch swallows it.",
  suggestion: "Rethrow it.",
  severity: "blocking",
};
const CLEAN_REVIEW = { findings: [] };
const BLOCKING_REVIEW = { findings: [FINDING] };

// What the verify, CI and review checks answer a failure with.
const VERIFY_FAILURE = "- lint: 1 error (log: /runs/issue-7/lint.log)";
const CI_FAILURE = "CI checks failed: build\nFailed-job logs: /runs/ci.log";

// The stop reasons.
/** @param {number} max @returns {string} the stop reason once `max` CI fixes are used */
function fixLimit(max) {
  return `checks still fail after ${max} CI-fix attempts`;
}
const CANNOT_FIX_REASON =
  "the check fixer can't fix the failing checks from the repo";
const BAD_FIX_REPLY = "the CI fixer's reply could not be read";
const BAD_REVIEW = "a check-fix reviewer failed";
const VERIFY_MOVED = "the branch changed during verification";
const CI_MOVED = "the branch changed outside the pipeline while CI ran";
const NO_CI =
  "the PR has no required CI checks, and this repo's config requires them";
const WIKI_ONLY_SUMMARY = "wiki-check: passed; no code changed";

/** @param {State} [saved] @param {RoleContext} [context] @returns {{ at: ImplState, data: ImplData }} where locate starts issue #7 saved at checks with a spec, a PR, a reviewed head that changes code and `saved`'s fields */
function checksLocated(saved = {}, context = implContext()) {
  return locate(
    {
      stage: "checks",
      spec: SPEC,
      pr: PR,
      headSha: HEAD,
      reviewedSha: HEAD,
      flows: CODE_FLOWS,
      ...saved,
    },
    context,
  );
}

/** @param {Record<string, unknown>} [fields] @returns {ImplData} a run's data at checks, with `fields` replacing its own; the checks entry's fields are plain here, and the table's own types check them */
function checksData(fields = {}) {
  return /** @type {ImplData} */ ({ ...checksLocated().data, ...fields });
}

/**
 * The step `result` (with `reply`) takes from `at` in the checks entry, with
 * `fields` in data. The entry's state and result names are plain strings
 * here; the table's own types check them.
 * @param {string} at
 * @param {string} result
 * @param {unknown} [reply]
 * @param {Record<string, unknown>} [fields]
 * @returns {Step<ImplState, ImplData>}
 */
function checksStep(at, result, reply = null, fields = {}) {
  const state = /** @type {MachineState<ImplState, ImplData>} */ ({
    at,
    data: checksData(fields),
  });
  const named = /** @type {Result<ImplResult>} */ ({ name: result, reply });
  return transition(state, named);
}

/** @param {{ state: { data: object } }} step @param {string} field @returns {unknown} the field of the step's data */
function fieldOf(step, field) {
  return new Map(Object.entries(step.state.data)).get(field);
}

/** @param {string} state @param {Record<string, unknown>} [fields] @returns {Effect} the effect of `state` with `fields` in data */
function effectAt(state, fields = {}) {
  const spec = new Map(Object.entries(TABLE.states)).get(state);
  if (spec === undefined) {
    throw new Error(`no state ${state}`);
  }
  return spec.effect(checksData(fields));
}

/** @param {Effect} effect @returns {SessionEffect} the effect, which must be a session */
function sessionOf(effect) {
  if (effect.kind !== "session") {
    throw new Error(`a ${effect.kind}, not a session`);
  }
  return effect;
}

/** @param {Effect} effect @returns {End} the end the effect ends with */
function endOf(effect) {
  if (effect.kind !== "end") {
    throw new Error(`a ${effect.kind}, not an end`);
  }
  return effect.end;
}

/** @param {End} end @returns {unknown} the detail a stop's stop op posts, or null for another end */
function detailOf(end) {
  if (end.kind !== "stopped") {
    return null;
  }
  const { detail } = end.after?.payload ?? {};
  return detail;
}

export {
  BAD_FIX_REPLY,
  BAD_REVIEW,
  BLOCKING_REVIEW,
  CANNOT_FIX,
  CANNOT_FIX_REASON,
  CI_FAILURE,
  CI_MOVED,
  CLEAN_REVIEW,
  CODE_FLOWS,
  checksData,
  checksLocated,
  checksStep,
  detailOf,
  effectAt,
  endOf,
  FINDING,
  FIXED,
  FIXED_HEAD,
  fieldOf,
  fixLimit,
  HANDOFF_FIX,
  HEAD,
  NO_CI,
  PR,
  sessionOf,
  VERIFY_FAILURE,
  VERIFY_MOVED,
  WIKI_ONLY_SUMMARY,
};
