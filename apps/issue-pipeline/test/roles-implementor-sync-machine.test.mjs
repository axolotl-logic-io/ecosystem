// @ts-check
// The implementor's start sync and its `sync` entry (#419; the wiki's
// Pipeline-Roles-Implementor, "Start sync", "Sync" and "Stacked branches"):
// every edge, the limits, where an old sync-stage state resumes, the stage
// list, and the conflict resolver's session and task.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTOR_STAGES,
  implementorMachine,
} from "../src/roles/implementor/implementor.ts";
import { LIMITS } from "../src/roles/implementor/machine.ts";
import { checkTable } from "../src/roles/machine.ts";
import { sessionBudget } from "../src/workflow/budget.ts";
import { NO_ARTIFICIAL_LOAD_RULE } from "../src/workflow/prompts.ts";
import { CIFIX_SCHEMA } from "../src/workflow/schemas.ts";
import {
  dataWith,
  HANDOFF_FILE,
  implContext,
  located,
} from "./implementor-role-test-kit.mjs";
import { SYNC_EDGES } from "./implementor-sync-edge-fixtures.mjs";
import {
  CONFLICT,
  endOf,
  RESOLVER_HANDOFF,
  STACKED_ON,
  stepOn,
  syncStep,
} from "./implementor-sync-test-kit.mjs";

/** @import { ImplData } from "../src/roles/implementor/locate.ts" */
/** @import { Effect, SessionEffect } from "../src/roles/machine.ts" */

/** @param {ImplData} data @param {string} field @returns {unknown} data's `field` */
function fieldOf(data, field) {
  return new Map(Object.entries(data)).get(field);
}

/** @param {Effect} effect @returns {Map<string, unknown>} a check's or op's payload, empty for any other effect */
function payloadOf(effect) {
  if (effect.kind !== "check" && effect.kind !== "op") {
    return new Map();
  }
  return new Map(Object.entries(effect.payload));
}

test("every edge of the start sync and the sync entry gives its next state, effect and data", () => {
  for (const edge of SYNC_EDGES) {
    const label = `${edge.at} ${edge.result}`;
    const step = syncStep(edge.at, edge.result, edge.reply, edge.data);
    assert.equal(step.state.at, edge.next, label);
    assert.deepEqual(endOf(step), edge.effect, label);
    for (const [field, value] of Object.entries(edge.changes ?? {})) {
      assert.deepEqual(
        fieldOf(step.state.data, field),
        value,
        `${label} ${field}`,
      );
    }
  }
});

test("the limits bound conflict fixes at 2 and the sync entry's rebases at 3 by default, from the config", () => {
  assert.deepEqual(LIMITS, {
    maxContinuations: 1,
    maxFixRounds: 2,
    maxConflictFixes: 2,
    maxSyncs: 3,
    maxCiFixes: 2,
  });
  const { limitsOf } = implementorMachine;
  assert.ok(limitsOf !== undefined);
  const set = implContext({
    maxContinuations: 3,
    maxFixRounds: 6,
    maxConflictFixes: 4,
    maxSyncs: 5,
    maxCiFixes: 7,
  });
  assert.deepEqual(limitsOf(set.cfg), {
    maxContinuations: 3,
    maxFixRounds: 6,
    maxConflictFixes: 4,
    maxSyncs: 5,
    maxCiFixes: 7,
  });
  const unset = implContext({ maxConflictFixes: null });
  const { maxConflictFixes } = limitsOf(unset.cfg);
  assert.equal(maxConflictFixes, 2);
  assert.deepEqual(
    checkTable(implementorMachine.table, LIMITS, dataWith()),
    [],
  );
});

test("the implementor runs the implement, fix, sync and checks stages, and hands off the sync's fields", () => {
  assert.deepEqual(IMPLEMENTOR_STAGES, ["implement", "fix", "sync", "checks"]);
  /** @type {Set<string>} */
  const handoff = new Set(implementorMachine.handoff);
  for (const field of [
    "headSha",
    "flows",
    "stackedOn",
    "syncs",
    "testsOnly",
    "passedSha",
  ]) {
    assert.ok(handoff.has(field), field);
  }
});

test("an issue saved at sync by today's stage resumes in the sync entry with its counts, the checkpoints winning", () => {
  const old = {
    stage: "sync",
    phase: "resolved",
    conflictFixes: 1,
    syncs: 2,
    testsOnly: true,
    passedSha: "bbbbbbb",
    stackedOn: STACKED_ON,
  };
  const { at, data } = located(old);
  assert.equal(at, "start");
  assert.equal(data.entry, "sync");
  assert.equal(data.conflictFixes, 1);
  assert.equal(data.syncs, 2);
  assert.equal(data.testsOnly, true);
  assert.equal(data.passedSha, "bbbbbbb");
  assert.deepEqual(data.stackedOn, STACKED_ON);
  const later = located({
    ...old,
    checkpoints: { conflictFixes: 2, syncs: 3 },
  });
  const { conflictFixes, syncs } = later.data;
  assert.deepEqual({ conflictFixes, syncs }, { conflictFixes: 2, syncs: 3 });
  assert.equal(located().data.entry, "implement");
});

test("the start check names the sync entry, and the start sync's checks carry what the issue is stacked on", () => {
  const { data } = located({ stage: "sync", stackedOn: STACKED_ON });
  const start = implementorMachine.table.states.start.effect(data);
  assert.equal(payloadOf(start).get("entry"), "sync");
  const work = syncStep("start", "sync", null, data);
  assert.deepEqual(payloadOf(work.effect).get("stackedOn"), STACKED_ON);
  const rebase = syncStep("sync-work?", "work", null, data);
  assert.deepEqual(payloadOf(rebase.effect).get("stackedOn"), STACKED_ON);
});

/** @returns {SessionEffect} the resolver a conflicting rebase starts */
function resolverSession() {
  const { effect } = syncStep("rebase", "conflict", CONFLICT, {
    conflictFixes: 0,
  });
  if (effect.kind !== "session") {
    throw new Error(`a conflict ran ${effect.kind}, not the resolver`);
  }
  return effect;
}

test("the resolver runs as today's writer with the fixer's model and budget, its schema, the files, the writers' commit rules and the load rule, and leaves the rebase to the role", () => {
  const context = implContext();
  const effect = resolverSession();
  assert.equal(effect.agent, "issue-pipeline-writer");
  assert.equal(effect.model, context.models.fixer);
  assert.equal(effect.budgetRole, "fixer");
  assert.equal(effect.tokenBudget, sessionBudget(context.budgets, "fixer"));
  assert.equal(effect.schema, CIFIX_SCHEMA);
  assert.equal(effect.attempt, 1);
  for (const part of [
    ...CONFLICT.files,
    "pipeline_commit",
    "Pipeline-Agent: conflict resolver",
    "Commit often, in small working steps",
    "`git -C repo add -A`",
    NO_ARTIFICIAL_LOAD_RULE,
    HANDOFF_FILE,
  ]) {
    assert.ok(effect.task.includes(part), `${part} in the task`);
  }
  assert.equal(effect.task.includes("GIT_EDITOR=true"), false);
});

test("a resolver that hands off gets one continuation, counted as neither a conflict fix nor an implementer continuation, then the rebase is aborted and the issue stops as too large", () => {
  const read = syncStep("resolver", "replied", RESOLVER_HANDOFF, {
    conflictFixes: 1,
  });
  const again = stepOn(read, "handoff");
  assert.equal(again.state.at, "resolver");
  assert.equal(again.state.data.conflictFixes, 1);
  assert.equal(again.state.data.continuations, 0);
  const second = stepOn(stepOn(again, "replied", RESOLVER_HANDOFF), "handoff");
  assert.equal(endOf(second), "check:abort");
  assert.deepEqual(endOf(stepOn(second, "aborted")), {
    kind: "stopped",
    code: "too-large",
  });
});
