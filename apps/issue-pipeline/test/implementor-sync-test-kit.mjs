// @ts-check
// The implementor's start sync and `sync` entry (#419) for issue #7: the
// replies its checks and its conflict resolver give, and a step through
// `transition` from a state or with a result the table may not list yet,
// which fails as a missing edge rather than a type error.
import { TABLE, transition } from "../src/roles/implementor/machine.ts";
import { dataWith, nameOf } from "./implementor-role-test-kit.mjs";

/** @import { ImplData, ImplState } from "../src/roles/implementor/locate.ts" */
/** @import { ImplResult } from "../src/roles/implementor/machine.ts" */
/** @import { Step } from "../src/roles/machine.ts" */

// The issue's pushed head before the sync, as located() saves it.
const HEAD = "aaaaaaa";
const STACKED_ON = { issue: 5, headSha: "fffffff" };
const MOVED_PREREQ = { issue: 5, headSha: "9999999" };
const FLOWS = { code: true, wiki: false };

// What the start sync's checks answer with: the branch already on the
// target's head, a clean rebase, a rebase stopped on conflicts, the next
// conflicting commit after `continue`, and a pushed resolution.
const UNCHANGED = { headSha: HEAD, flows: FLOWS, stackedOn: null };
const REBASED = { headSha: "ccccccc", flows: FLOWS, stackedOn: null };
const REBASED_STACKED = {
  headSha: "ccccccc",
  flows: FLOWS,
  stackedOn: MOVED_PREREQ,
};
const CONFLICT = { files: ["README.md"], baseSha: "ddddddd", stackedOn: null };
const NEXT_CONFLICT = { files: ["src/a.ts"] };
const FINISHED = { headSha: "eeeeeee", flows: FLOWS, stackedOn: null };

// The conflict resolver's replies (CIFIX_SCHEMA).
const FIXED = { status: "fixed", summary: "Kept the base's rename." };
const RESOLVER_HANDOFF = { status: "handoff", summary: "Two files left." };

/** @param {string} name @returns {name is ImplState} whether the table has a state `name` */
function isState(name) {
  return Object.hasOwn(TABLE.states, name);
}

/** @param {ImplState} at @param {string} name @returns {name is ImplResult} whether `at` lists result `name` */
function isListed(at, name) {
  return Object.hasOwn(TABLE.states[at].on, name);
}

/**
 * The step `result` (with `reply`) takes from `at`, with `fields` in data;
 * it fails when the table has no such state or edge.
 * @param {string} at
 * @param {string} result
 * @param {unknown} [reply]
 * @param {Partial<ImplData>} [fields]
 * @returns {Step<ImplState, ImplData>}
 */
function syncStep(at, result, reply = null, fields = {}) {
  if (!isState(at)) {
    throw new Error(`the implementor has no state ${at}`);
  }
  if (!isListed(at, result)) {
    throw new Error(`${at} doesn't take ${result}`);
  }
  return transition({ at, data: dataWith(fields) }, { name: result, reply });
}

/**
 * The step `result` (with `reply`) takes from where `step` left the run.
 * @param {Step<ImplState, ImplData>} step
 * @param {string} result
 * @param {unknown} [reply]
 * @returns {Step<ImplState, ImplData>}
 */
function stepOn(step, result, reply = null) {
  const { at } = step.state;
  if (!isListed(at, result)) {
    throw new Error(`${at} doesn't take ${result}`);
  }
  return transition(step.state, { name: result, reply });
}

/** @param {Step<ImplState, ImplData>} step @returns {string | Readonly<Record<string, string>>} the step's op, check or session name, or its end's kind, code and stage */
function endOf(step) {
  const named = nameOf(step.effect);
  if (typeof named === "string") {
    return named;
  }
  const { kind } = named;
  if (named.kind === "stopped") {
    return { kind, code: named.code };
  }
  if (named.kind === "saved" || named.kind === "next") {
    return { kind, stage: named.stage };
  }
  return { kind };
}

export {
  CONFLICT,
  endOf,
  FINISHED,
  FIXED,
  FLOWS,
  HEAD,
  MOVED_PREREQ,
  NEXT_CONFLICT,
  REBASED,
  REBASED_STACKED,
  RESOLVER_HANDOFF,
  STACKED_ON,
  stepOn,
  syncStep,
  UNCHANGED,
};
