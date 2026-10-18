// @ts-check
// The implementor role's machine (#414): every edge of the shared start and
// the `implement` entry as a state and a result (the wiki's
// Pipeline-Roles-Implementor, "Lifecycle"), the table's faults, its limits,
// what it writes, and the implementer's session and task.
import assert from "node:assert/strict";
import { test } from "node:test";
import { implementorMachine } from "../src/roles/implementor/implementor.ts";
import { LIMITS, TABLE } from "../src/roles/implementor/machine.ts";
import { IMPL_SCHEMA } from "../src/roles/implementor/reply.ts";
import { checkTable } from "../src/roles/machine.ts";
import { sessionBudget } from "../src/workflow/budget.ts";
import { ALL_LENSES } from "../src/workflow/lenses.ts";
import {
  handoffLead,
  NO_ARTIFICIAL_LOAD_RULE,
} from "../src/workflow/prompts.ts";
import { EDGES } from "./implementor-edge-fixtures.mjs";
import { FIX_EDGES } from "./implementor-fix-edge-fixtures.mjs";
import {
  DONE,
  dataWith,
  HANDOFF,
  HANDOFF_FILE,
  ISSUE,
  implContext,
  nameOf,
  PRACTICES,
  SPEC,
  stepFrom,
} from "./implementor-role-test-kit.mjs";

/** @import { ImplData, ImplState } from "../src/roles/implementor/locate.ts" */
/** @import { ImplResult } from "../src/roles/implementor/machine.ts" */
/** @import { Effect, End, SessionEffect } from "../src/roles/machine.ts" */
/** @import { EdgeCase } from "./implementor-edge-fixtures.mjs" */

/** @param {ImplState} at @param {ImplResult} result @param {unknown} reply @param {Partial<ImplData>} [fields] @returns {SessionEffect} the session the step runs */
function sessionFrom(at, result, reply, fields = {}) {
  const { effect } = stepFrom(at, result, reply, fields);
  if (effect.kind !== "session") {
    throw new Error(`${at} ${result} ran ${effect.kind}, not a session`);
  }
  return effect;
}

/** @param {string | End} effect @returns {string | End} the effect, its stop's detail left out */
function withoutDetail(effect) {
  if (typeof effect === "string" || effect.kind !== "stopped") {
    return effect;
  }
  const { after } = effect;
  if (after === undefined) {
    return effect;
  }
  const { detail: _detail, ...payload } = after.payload;
  return { ...effect, after: { ...after, payload } };
}

/** @param {EdgeCase} edge @param {string | End} effect @returns {string | End} the effect as the edge's case pins it: a changed-nothing stop's detail is the job's to word */
function pinned(edge, effect) {
  if (edge.next === "changed-nothing") {
    return withoutDetail(effect);
  }
  return effect;
}

test("every edge of the start and the implement entry gives its next state, effect and data", () => {
  for (const edge of EDGES) {
    const label = `${edge.at} ${edge.result}`;
    const step = stepFrom(edge.at, edge.result, edge.reply, edge.data);
    assert.equal(step.state.at, edge.next, label);
    assert.deepEqual(
      pinned(edge, nameOf(step.effect)),
      pinned(edge, edge.effect),
      label,
    );
    for (const [field, value] of Object.entries(edge.changes ?? {})) {
      assert.deepEqual(
        new Map(Object.entries(step.state.data)).get(field),
        value,
        `${label} ${field}`,
      );
    }
  }
});

// The states that run a model: the implementer, the fixer and a re-reviewer
// for each lens (#418).
const SESSIONS = new Set([
  "implementer",
  "fixer",
  ...ALL_LENSES.map((lens) => `rereview-${lens}`),
]);

test("every listed edge is covered, only the implementer, the fixer and the re-reviewers run a model, and no state sends a PR op", () => {
  const edges = [...EDGES, ...FIX_EDGES];
  for (const [name, spec] of Object.entries(TABLE.states)) {
    assert.equal(spec.kind === "session", SESSIONS.has(name), name);
    for (const result of Object.keys(spec.on)) {
      const listed = edges.some(
        (edge) => edge.at === name && edge.result === result,
      );
      assert.ok(listed, `${name} ${result}`);
    }
  }
  const sent = Object.values(TABLE.states)
    .map((spec) => nameOf(spec.effect(dataWith({ reply: DONE }))))
    .filter((name) => typeof name === "string" && name.startsWith("op:"));
  for (const prOp of ["op:open-pr", "op:start-pr", "op:close-pr"]) {
    assert.equal(sent.includes(prOp), false, prOp);
  }
  assert.deepEqual(TABLE.entries, ["start"]);
});

test("the table has no faults under its limits", () => {
  assert.deepEqual(LIMITS, { maxContinuations: 1, maxFixRounds: 2 });
  assert.deepEqual(checkTable(TABLE, LIMITS, dataWith()), []);
});

/** @param {Effect} effect @returns {unknown[]} the issue its payload names, for an op or a check */
function issuesOf(effect) {
  if (effect.kind !== "op" && effect.kind !== "check") {
    return [];
  }
  const { number } = effect.payload;
  return [number];
}

/** @param {Effect} effect @returns {unknown} the entry a check's payload names */
function entryOf(effect) {
  if (effect.kind !== "check") {
    return null;
  }
  const { entry } = effect.payload;
  return entry;
}

test("the start check names the entry, and every op and check names the issue", () => {
  assert.equal(entryOf(TABLE.states.start.effect(dataWith())), "implement");
  const named = EDGES.flatMap((edge) =>
    issuesOf(stepFrom(edge.at, edge.result, edge.reply, edge.data).effect),
  );
  assert.ok(named.length > 0);
  assert.deepEqual(new Set(named), new Set([ISSUE]));
});

test("a reply that doesn't read stops the issue as a failed session", () => {
  const read = stepFrom("implementer", "replied", { status: "finished" });
  assert.equal(read.state.data.reply, null);
  const step = stepFrom("implementer-reply", "bad", null, { reply: null });
  assert.equal(step.state.at, "bad-reply");
  const { effect } = step;
  assert.ok(effect.kind === "end" && effect.end.kind === "stopped");
  assert.equal(effect.end.code, "error");
});

test("the limits on continuations and fix rounds are the config's maxContinuations and maxFixRounds", () => {
  const { limitsOf } = implementorMachine;
  assert.ok(limitsOf !== undefined);
  const { cfg } = implContext({ maxContinuations: 3, maxFixRounds: 4 });
  assert.deepEqual(limitsOf(cfg), { maxContinuations: 3, maxFixRounds: 4 });
});

test("the machine checkpoints its counts and hands off the head, the flows, the reply, the findings and the re-review's fields", () => {
  assert.deepEqual(
    new Set(implementorMachine.checkpoints),
    new Set([
      "continuations",
      "fixContinuations",
      "fixRounds",
      "conflictFixes",
      "ciFixRounds",
    ]),
  );
  assert.deepEqual(
    new Set(implementorMachine.handoff),
    new Set([
      "headSha",
      "flows",
      "implemented",
      "reply",
      "findings",
      "round",
      "reviewedSha",
      "reviewedPatchId",
      "nextFindingId",
      "resolvedHistory",
      "testsOnly",
    ]),
  );
  assert.equal(implementorMachine.table, TABLE);
});

test("the implementer runs as today's writer, with the role's schema, the practices, the load rule, the commit rules and the context limits", () => {
  const context = implContext();
  const effect = sessionFrom("setup", "ok", null);
  assert.equal(effect.agent, "issue-pipeline-writer");
  assert.equal(effect.model, context.models.implementer);
  assert.equal(effect.budgetRole, "implementer");
  assert.equal(
    effect.tokenBudget,
    sessionBudget(context.budgets, "implementer"),
  );
  assert.equal(effect.schema, IMPL_SCHEMA);
  assert.equal(effect.attempt, 1);
  const { task } = effect;
  for (const part of [
    ...PRACTICES,
    SPEC,
    NO_ARTIFICIAL_LOAD_RULE,
    "pipeline_commit",
    "Pipeline-Agent: implementer",
    HANDOFF_FILE,
    `at ${context.budgets.softLimit} tokens of context`,
    `At ${context.budgets.hardLimit} tokens of context`,
  ]) {
    assert.ok(task.includes(part), `${part} in the task`);
  }
  assert.equal(task.includes("prTitle"), false);
  assert.equal(task.includes("prBody"), false);
});

test("a continuation's task starts from the handoff", () => {
  const effect = sessionFrom("implementer-reply", "handoff", null, {
    reply: HANDOFF,
    continuations: 0,
  });
  assert.equal(effect.attempt, 2);
  assert.ok(effect.task.includes(handoffLead(HANDOFF_FILE)), effect.task);
});
