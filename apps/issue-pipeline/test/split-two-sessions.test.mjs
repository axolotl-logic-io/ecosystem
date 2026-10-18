// @ts-check
// The two-session split rule (#413, roles-6-10-scope): the spec writer's task,
// on the role runner and in lanes, offers `split` only when implementing and
// testing the issue would take more than two implementer sessions, and names
// that bound in tokens, twice the config's `contextLimits.soft`; each part
// must fit in two sessions. Triage's task uses the same bound for `ready` and
// `split`. A sub-issue still can't split.
import assert from "node:assert/strict";
import { test } from "node:test";
import { transition } from "../src/roles/spec-writer/machine.ts";
import { locate as triageLocate } from "../src/roles/triage/locate.ts";
import { next as specNext } from "../src/workflow/stages/spec.ts";
import { next as triageNext } from "../src/workflow/stages/triage.ts";
import { roleContext } from "./role-context-fixtures.mjs";
import { located, PRACTICES } from "./spec-writer-role-test-kit.mjs";
import { sessions } from "./stage-outcome-test-kit.mjs";
import { BUILD_CTX, buildState } from "./workflow-build-test-kit.mjs";
import { CTX, stateWith } from "./workflow-triage-test-kit.mjs";

/** @import { StageContext } from "../src/workflow/stages/types.ts" */

// The soft limits the tests build tasks with, and the per-session cap the
// fixtures keep, which the split bound must no longer name.
const DEFAULT_SOFT = 175_000;
const OTHER_SOFT = 100_000;
const SOFT_LIMITS = [DEFAULT_SOFT, OTHER_SOFT];
// How far above the soft limit the tests put the hard limit.
const HARD_MARGIN = 50_000;
const SESSION_CAP = 150_000;
const MORE_THAN_TWO = /\bmore than two implementer sessions\b/u;
const EACH_PART_FITS_TWO = /\beach\b[^.]*\btwo implementer sessions\b/u;
const ONE_SESSION = /\bone implementer session\b/u;
const TWO_SESSIONS = /\btwo implementer sessions\b/u;
const SPLIT_UNLESS_TWO =
  /Split it unless your spec shows the change fits two sessions\./u;
const FITS_ONE = /\bfits one session\b/u;
const NOT_ALLOWED = /splitting is not allowed/u;
const SPLIT_OFFER = "set `decision` to split";
const REASON = "Three subsystems change.";

/** @param {number} soft @returns {number} the split bound for `soft`, in tokens */
function boundOf(soft) {
  return 2 * soft;
}

/** @param {string} task @param {(line: string) => boolean} pick @returns {string} the task's one line `pick` chooses, or "" */
function lineOf(task, pick) {
  return task.split("\n").find(pick) ?? "";
}

/**
 * The spec writer role's task with the config's soft limit `soft`.
 * @param {number} soft @param {Record<string, unknown>} [saved]
 * @returns {string}
 */
function roleSpecTask(soft, saved = {}) {
  const context = roleContext({
    practices: PRACTICES,
    contextLimits: { soft, hard: soft + HARD_MARGIN },
  });
  const { data } = located(saved, context);
  const { effect } = transition(
    { at: "retry", data },
    { name: "ok", reply: null },
  );
  if (effect.kind !== "session") {
    throw new Error(`a retry ran ${effect.kind}, not a session`);
  }
  return effect.task;
}

/** @param {StageContext} ctx @param {number} soft @returns {StageContext} `ctx` with the soft limit `soft` */
function withSoft(ctx, soft) {
  return { ...ctx, budgets: { ...ctx.budgets, softLimit: soft } };
}

/**
 * The lane spec stage's task with the soft limit `soft`.
 * @param {number} soft @param {Parameters<typeof buildState>[1]} [fields]
 * @returns {string}
 */
function laneSpecTask(soft, fields = {}) {
  const step = specNext(
    buildState("spec", fields),
    withSoft(BUILD_CTX, soft),
    [],
  );
  const [session] = sessions(step);
  return session?.task ?? "";
}

/** @param {number} soft @returns {string} the triage role's task with the config's soft limit `soft` */
function roleTriageTask(soft) {
  const context = roleContext({
    contextLimits: { soft, hard: soft + HARD_MARGIN },
  });
  const { start } = triageLocate({}, context).data;
  if (start.kind !== "session") {
    throw new Error(`triage started with ${start.kind}, not a session`);
  }
  return start.session.task;
}

/** @param {number} soft @returns {string} the lane triage stage's task with the soft limit `soft` */
function laneTriageTask(soft) {
  const [session] = sessions(triageNext(stateWith(), withSoft(CTX, soft), []));
  return session?.task ?? "";
}

/**
 * What the split line of `task` says, for a soft limit of `soft`.
 * @param {string} task @param {number} soft
 * @returns {Record<string, boolean>}
 */
function splitFacts(task, soft) {
  const line = lineOf(task, (text) => text.includes(SPLIT_OFFER));
  return {
    namesBound: line.includes(`${boundOf(soft)} tokens of context`),
    moreThanTwo: MORE_THAN_TWO.test(line),
    eachPartFitsTwo: EACH_PART_FITS_TWO.test(line),
    namesOneSession: ONE_SESSION.test(line),
    namesSessionCap: line.includes(String(SESSION_CAP)),
  };
}

// What the split line says once it follows the two-session rule.
const TWO_SESSION_SPLIT = {
  namesBound: true,
  moreThanTwo: true,
  eachPartFitsTwo: true,
  namesOneSession: false,
  namesSessionCap: false,
};

test("the spec writer role offers split past two sessions, twice contextLimits.soft", () => {
  for (const soft of SOFT_LIMITS) {
    assert.deepEqual(splitFacts(roleSpecTask(soft), soft), TWO_SESSION_SPLIT);
  }
});

test("the lane spec writer offers split past two sessions, twice contextLimits.soft", () => {
  for (const soft of SOFT_LIMITS) {
    assert.deepEqual(splitFacts(laneSpecTask(soft), soft), TWO_SESSION_SPLIT);
  }
});

test("a suggested split asks to split unless the spec shows the change fits two sessions", () => {
  const soft = DEFAULT_SOFT;
  const tasks = [
    roleSpecTask(soft, { splitSuggested: REASON }),
    laneSpecTask(soft, { splitSuggested: REASON }),
  ];
  for (const task of tasks) {
    const finding = lineOf(task, (text) => text.includes(REASON));
    assert.match(finding, SPLIT_UNLESS_TWO);
    assert.doesNotMatch(finding, FITS_ONE);
  }
});

test("triage is ready within two sessions and splits past them, at the same bound", () => {
  for (const soft of SOFT_LIMITS) {
    for (const task of [roleTriageTask(soft), laneTriageTask(soft)]) {
      const ready = lineOf(task, (text) => text.startsWith("- ready:"));
      assert.ok(ready.includes(`${boundOf(soft)} tokens of context`), ready);
      assert.match(ready, TWO_SESSIONS);
      assert.doesNotMatch(ready, ONE_SESSION);
      const split = lineOf(task, (text) => text.startsWith("- split:"));
      assert.match(split, MORE_THAN_TWO);
    }
  }
});

/** @param {number} soft @returns {string} the role spec writer's whole split line for `soft` */
function roleSplitLine(soft) {
  return `Only if implementing and testing it would take more than two implementer sessions (more than ${boundOf(soft)} tokens of context, twice \`contextLimits.soft\`), set \`decision\` to split and give 2 to 5 \`subIssues\`, each a complete, independently testable change with its own acceptance criteria that two implementer sessions can implement and test. Put its slice of the spec, with its interfaces, in its \`body\`. Use \`after\` to list the 0-based indexes of earlier parts that must merge first. Cut along file boundaries, order parts that must edit the same file with \`after\`, and prefer fewer parts.`;
}

test("the spec writer role's split line reads exactly as specified", () => {
  for (const soft of SOFT_LIMITS) {
    const line = lineOf(roleSpecTask(soft), (text) =>
      text.includes(SPLIT_OFFER),
    );
    assert.equal(line, roleSplitLine(soft));
  }
});

test("both spec writers state triage's suggested split exactly as specified", () => {
  const finding = `Triage judged this issue too big for two implementer sessions: ${REASON} Split it unless your spec shows the change fits two sessions. Its notes:`;
  const tasks = [
    roleSpecTask(DEFAULT_SOFT, { splitSuggested: REASON }),
    laneSpecTask(DEFAULT_SOFT, { splitSuggested: REASON }),
  ];
  for (const task of tasks) {
    assert.ok(task.includes(finding), task);
  }
});

test("a sub-issue's spec writer still may not split, on the role and in lanes", () => {
  const soft = DEFAULT_SOFT;
  for (const task of [
    roleSpecTask(soft, { depth: 1 }),
    laneSpecTask(soft, { depth: 1 }),
  ]) {
    assert.match(task, NOT_ALLOWED);
    assert.equal(task.includes(`${boundOf(soft)} tokens`), false, task);
  }
});
