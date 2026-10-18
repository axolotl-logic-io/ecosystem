// @ts-check
// The implementor's `fix` entry (#418; the wiki's Pipeline-Roles-Implementor,
// "Entry `fix`" and "Fix (the fixer's half)", and Pipeline-Roles-Reviewer,
// "Re-review"): every edge as a state and a result, the fixer's and the
// re-reviewers' sessions and tasks from today's fix and rereview stages,
// the re-review diff's request, and the per-lens checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TABLE } from "../src/roles/implementor/machine.ts";
import { sessionBudget } from "../src/workflow/budget.ts";
import { findingsText } from "../src/workflow/findings.ts";
import { ALL_LENSES, LENSES } from "../src/workflow/lenses.ts";
import {
  handoffLead,
  NO_ARTIFICIAL_LOAD_RULE,
} from "../src/workflow/prompts.ts";
import {
  FIX_SCHEMA,
  REREVIEW_SCHEMA,
  REREVIEW_SEC_SCHEMA,
} from "../src/workflow/review-schemas.ts";
import { FIX_EDGES } from "./implementor-fix-edge-fixtures.mjs";
import {
  DIFF_PATH,
  F1,
  FIX_HANDOFF,
  FIXED_HEAD,
  fixData,
  fixStepFrom,
  REVIEWED,
  SEC,
  SPEC,
} from "./implementor-fix-test-kit.mjs";
import {
  HANDOFF_FILE,
  ISSUE,
  implContext,
  nameOf,
  PRACTICES,
} from "./implementor-role-test-kit.mjs";

/** @import { ImplData, ImplState } from "../src/roles/implementor/locate.ts" */
/** @import { ImplResult } from "../src/roles/implementor/machine.ts" */
/** @import { Effect, SessionEffect } from "../src/roles/machine.ts" */
/** @import { Lens } from "../src/workflow/lenses.ts" */
/** @import { Finding } from "./implementor-fix-test-kit.mjs" */

const OLD_RESOLVED = "f0: Old bug";

/** @param {ImplState} at @param {ImplResult} result @param {unknown} reply @param {Partial<ImplData>} [fields] @returns {SessionEffect} the session the step runs */
function sessionFrom(at, result, reply, fields = {}) {
  const { effect } = fixStepFrom(at, result, reply, fields);
  if (effect.kind !== "session") {
    throw new Error(`${at} ${result} ran ${effect.kind}, not a session`);
  }
  return effect;
}

/** @param {Effect} effect @returns {Readonly<Record<string, unknown>>} an op's or check's payload */
function payloadOf(effect) {
  if (effect.kind !== "op" && effect.kind !== "check") {
    throw new Error(`a ${effect.kind} effect has no payload`);
  }
  return effect.payload;
}

/** @param {ImplState} at @param {Partial<ImplData>} [fields] @returns {Effect} the effect of `at` on a fix run's data with `fields` */
function effectAt(at, fields = {}) {
  const spec = new Map(Object.entries(TABLE.states)).get(at);
  if (spec === undefined) {
    throw new Error(`TABLE has no ${at}`);
  }
  return spec.effect(fixData(fields));
}

/** @param {Lens} lens @returns {object} the re-review schema of `lens` */
function schemaOf(lens) {
  if (lens === "security") {
    return REREVIEW_SEC_SCHEMA;
  }
  return REREVIEW_SCHEMA;
}

test("every edge of the fix entry gives its next state, effect and data", () => {
  for (const edge of FIX_EDGES) {
    const label = `${edge.at} ${edge.result}`;
    assert.ok(Object.hasOwn(TABLE.states, edge.at), `TABLE has ${edge.at}`);
    const step = fixStepFrom(edge.at, edge.result, edge.reply, edge.data);
    assert.equal(step.state.at, edge.next, label);
    assert.deepEqual(nameOf(step.effect), edge.effect, label);
    for (const [field, value] of Object.entries(edge.changes ?? {})) {
      assert.deepEqual(
        new Map(Object.entries(step.state.data)).get(field),
        value,
        `${label} ${field}`,
      );
    }
  }
});

test("the fix entry's states take only the listed results", () => {
  // The shared start's other edge is the implement entry's, which
  // roles-implementor-machine.test.mjs checks with both fixtures.
  const fixStates = new Set(
    FIX_EDGES.map((edge) => edge.at).filter((at) => at !== "start"),
  );
  assert.ok(fixStates.has("update-findings"));
  for (const at of fixStates) {
    const spec = new Map(Object.entries(TABLE.states)).get(at);
    assert.ok(spec !== undefined, at);
    for (const result of Object.keys(spec.on)) {
      const listed = FIX_EDGES.some(
        (edge) => edge.at === at && edge.result === result,
      );
      assert.ok(listed, `${at} ${result}`);
    }
  }
});

test("the start check names the fix entry for a run saved at fix", () => {
  const { entry, number } = payloadOf(effectAt("start"));
  assert.equal(entry, "fix");
  assert.equal(number, ISSUE);
});

test("the fixer runs as today's fixer: the writer agent, FIX_SCHEMA, the open findings, the spec, the practices and the round", () => {
  const context = implContext();
  const effect = sessionFrom("fix-work?", "open", null, {
    fixRounds: 0,
    findings: [F1],
  });
  assert.equal(effect.agent, "issue-pipeline-writer");
  assert.equal(effect.model, context.models.fixer);
  assert.equal(effect.schema, FIX_SCHEMA);
  assert.equal(effect.budgetRole, "fixer");
  assert.equal(effect.tokenBudget, sessionBudget(context.budgets, "fixer"));
  assert.equal(effect.attempt, 1);
  for (const part of [
    ...PRACTICES,
    SPEC,
    findingsText([F1]),
    "fixer, round 1 of 2",
    "pipeline_commit",
    "Pipeline-Agent: fixer round 1",
    NO_ARTIFICIAL_LOAD_RULE,
    HANDOFF_FILE,
  ]) {
    assert.ok(effect.task.includes(part), `${part} in the task`);
  }
  assert.equal(effect.task.includes(handoffLead(HANDOFF_FILE)), false);
});

test("a fixer continuation keeps its round and starts from the handoff", () => {
  const effect = sessionFrom("fixer-reply", "handoff", null, {
    fixRounds: 1,
    fixReply: FIX_HANDOFF,
    fixContinuations: 0,
  });
  assert.equal(effect.name, "fix-r1-c1");
  assert.equal(effect.attempt, 1);
  assert.ok(effect.task.includes(handoffLead(HANDOFF_FILE)), effect.task);
});

/** @param {Lens} lens @returns {SessionEffect} the re-reviewer `lens`'s check opens in round 1, with F1 and SEC open */
function rereviewer(lens) {
  const at = /** @type {ImplState} */ (`rereview-${lens}?`);
  return sessionFrom(at, "open", null, {
    fixRounds: 1,
    headSha: FIXED_HEAD,
    diffPath: DIFF_PATH,
    findings: [F1, SEC],
    resolvedHistory: [OLD_RESOLVED],
  });
}

test("each lens's re-reviewer runs as today's: the reader agent, its lens's model and schema, its findings, the diff and the resolved history", () => {
  const context = implContext();
  for (const lens of ALL_LENSES) {
    const effect = rereviewer(lens);
    assert.equal(effect.name, `rereview-${lens}-r1`, lens);
    assert.equal(effect.agent, "issue-pipeline-reader", lens);
    assert.equal(effect.model, context.models[lens], lens);
    assert.equal(effect.schema, schemaOf(lens), lens);
    assert.equal(effect.budgetRole, "rereviewer", lens);
    assert.equal(
      effect.tokenBudget,
      sessionBudget(context.budgets, "rereviewer"),
      lens,
    );
    for (const part of [LENSES[lens], DIFF_PATH, OLD_RESOLVED]) {
      assert.ok(effect.task.includes(part), `${lens}: ${part} in the task`);
    }
  }
  assert.ok(rereviewer("correctness").task.includes(findingsText([F1])));
  assert.equal(rereviewer("correctness").task.includes(SEC.title), false);
  assert.ok(rereviewer("security").task.includes(findingsText([SEC])));
});

test("each lens's check counts only its lens's open findings", () => {
  /** @type {Finding[]} */
  const findings = [F1, { ...SEC, status: "resolved" }];
  /** @type {Record<string, number>} */
  const counts = {};
  for (const lens of ALL_LENSES) {
    const at = /** @type {ImplState} */ (`rereview-${lens}?`);
    const { lens: named, number, open } = payloadOf(effectAt(at, { findings }));
    assert.equal(named, lens);
    assert.equal(number, ISSUE);
    counts[lens] = Number(open);
  }
  assert.deepEqual(counts, {
    correctness: 1,
    tests: 0,
    scope: 0,
    security: 0,
    acceptance: 0,
  });
});

test("the re-review diff is prepared since the reviewed head, tagged by round and security round, on the stack", () => {
  const plain = payloadOf(effectAt("prepare-rereview", { fixRounds: 1 }));
  assert.deepEqual(plain, { number: ISSUE, sinceSha: REVIEWED, tag: "r1" });
  const stackedOn = { issue: 5, headSha: "ppppppp" };
  const later = payloadOf(
    effectAt("prepare-rereview", {
      fixRounds: 2,
      securityRounds: 1,
      stackedOn,
    }),
  );
  assert.deepEqual(later, {
    number: ISSUE,
    sinceSha: REVIEWED,
    tag: "s1-r2",
    stackedOn,
  });
});
