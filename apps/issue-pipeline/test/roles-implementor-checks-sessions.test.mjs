// @ts-check
// The implementor role's `checks` entry (#420; the wiki's
// Pipeline-Roles-Implementor, "Entry `checks`"): its CI fixer and check-fix
// reviewers as sessions, the details its stops carry, the limits and the
// fields the machine writes, and the stage it registers.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTOR_STAGES,
  implementorMachine,
} from "../src/roles/implementor/implementor.ts";
import { roleOf } from "../src/roles/registry.ts";
import { sessionBudget } from "../src/workflow/budget.ts";
import { LENSES } from "../src/workflow/lenses.ts";
import {
  handoffLead,
  NO_ARTIFICIAL_LOAD_RULE,
} from "../src/workflow/prompts.ts";
import { REVIEW_SCHEMA } from "../src/workflow/review-schemas.ts";
import { CIFIX_SCHEMA } from "../src/workflow/schemas.ts";
import {
  CANNOT_FIX,
  checksStep,
  detailOf,
  endOf,
  HANDOFF_FIX,
  sessionOf,
  VERIFY_FAILURE,
} from "./implementor-checks-test-kit.mjs";
import {
  HANDOFF_FILE,
  implContext,
  PRACTICES,
} from "./implementor-role-test-kit.mjs";

/** @import { SessionEffect } from "../src/roles/machine.ts" */

const DIFF_PATH = "/runs/issue-7/cifix1.diff";

/** @param {SessionEffect} effect @returns {Record<string, unknown>} what a check-fix reviewer's session pins: its attributes, and whether its task names a concern and the fix's diff */
function reviewerOf(effect) {
  const { name, agent, model, schema, budgetRole, task } = effect;
  return {
    name,
    agent,
    model,
    schema,
    budgetRole,
    concern: task.includes("Concern: "),
    diff: task.includes(DIFF_PATH),
  };
}

test("the CI fixer runs as today's writer with the fixer model, the CI-fix schema and budget, the failure and the rules", () => {
  const context = implContext();
  const effect = sessionOf(
    checksStep(
      "verify",
      "fail",
      { failure: VERIFY_FAILURE },
      { ciFixRounds: 0 },
    ).effect,
  );
  assert.equal(effect.name, "cifix-1");
  assert.equal(effect.agent, "issue-pipeline-writer");
  assert.equal(effect.model, context.models.fixer);
  assert.equal(effect.schema, CIFIX_SCHEMA);
  assert.equal(effect.budgetRole, "ciFixer");
  assert.equal(effect.tokenBudget, sessionBudget(context.budgets, "ciFixer"));
  assert.equal(effect.attempt, 1);
  for (const part of [
    ...PRACTICES,
    "These checks failed:",
    VERIFY_FAILURE,
    "Pipeline-Agent: check fixer",
    "cannot-fix",
    NO_ARTIFICIAL_LOAD_RULE,
    HANDOFF_FILE,
  ]) {
    assert.ok(effect.task.includes(part), `${part} in the task`);
  }
  assert.equal(effect.task.includes(handoffLead(HANDOFF_FILE)), false);
});

test("a fixer's continuation keeps its failure and leads with the handoff", () => {
  const effect = sessionOf(
    checksStep("ci-fixer-reply", "handoff", null, {
      fix: HANDOFF_FIX,
      failure: VERIFY_FAILURE,
      ciFixRounds: 1,
      ciFixContinuations: 0,
    }).effect,
  );
  assert.equal(effect.name, "cifix-1-c1");
  assert.ok(effect.task.startsWith(handoffLead(HANDOFF_FILE)), effect.task);
  assert.ok(effect.task.includes(VERIFY_FAILURE));
});

test("the check-fix reviewers read the fix's diff with their lens's model, the review schema and the rereviewer budget", () => {
  const correctness = sessionOf(
    checksStep(
      "prepare-fix-review",
      "ok",
      { ok: true, diffPath: DIFF_PATH, patchId: "p1" },
      { ciFixRounds: 1 },
    ).effect,
  );
  const scope = sessionOf(
    checksStep(
      "check-fix-correctness",
      "replied",
      { findings: [] },
      {
        ciFixRounds: 1,
        diffPath: DIFF_PATH,
        reviews: [],
      },
    ).effect,
  );
  const context = implContext();
  for (const [lens, effect] of /** @type {const} */ ([
    ["correctness", correctness],
    ["scope", scope],
  ])) {
    const concern = new Map(Object.entries(LENSES)).get(lens);
    assert.deepEqual(reviewerOf(effect), {
      name: `cifix-review-${lens}-1`,
      agent: "issue-pipeline-reader",
      model: new Map(Object.entries(context.models)).get(lens),
      schema: REVIEW_SCHEMA,
      budgetRole: "rereviewer",
      concern: true,
      diff: true,
    });
    assert.ok(effect.task.includes(`Concern: ${concern}`), lens);
  }
});

test("the stops carry the failure, the fixer's summary or its handoff as detail", () => {
  const limit = checksStep(
    "ci-status",
    "fail",
    { failure: "CI failed" },
    {
      ciFixRounds: 2,
      maxCiFixes: 2,
    },
  );
  assert.equal(detailOf(endOf(limit.effect)), "CI failed");
  const cannot = checksStep("ci-fixer-reply", "cannot-fix", null, {
    fix: CANNOT_FIX,
  });
  assert.equal(detailOf(endOf(cannot.effect)), CANNOT_FIX.summary);
  const room = checksStep("ci-fixer-reply", "handoff", null, {
    fix: HANDOFF_FIX,
    ciFixContinuations: 1,
  });
  assert.equal(
    detailOf(endOf(room.effect)),
    `Latest handoff: ${HANDOFF_FILE}\n\n${HANDOFF_FIX.summary}`,
  );
});

test("the limits are the config's maxContinuations and maxCiFixes, and the machine writes the checks entry's fields", () => {
  const { limitsOf } = implementorMachine;
  assert.ok(limitsOf !== undefined);
  const { cfg } = implContext({ maxContinuations: 3, maxCiFixes: 4 });
  const { maxContinuations, maxCiFixes } = limitsOf(cfg);
  assert.deepEqual(
    { maxContinuations, maxCiFixes },
    {
      maxContinuations: 3,
      maxCiFixes: 4,
    },
  );
  /** @type {Set<string>} */
  const handoff = new Set(implementorMachine.handoff);
  for (const field of [
    "headSha",
    "flows",
    "verifiedSha",
    "verifySummary",
    "testsOnly",
    "reviewedSha",
    "reviewedPatchId",
    "stackedOn",
    "pr",
  ]) {
    assert.ok(handoff.has(field), `hands off ${field}`);
  }
  /** @type {Set<string>} */
  const checkpoints = new Set(implementorMachine.checkpoints);
  for (const field of ["ciFixRounds", "ciFixContinuations"]) {
    assert.ok(checkpoints.has(field), `checkpoints ${field}`);
  }
});

test("a stage job at checks runs the implementor role", () => {
  assert.deepEqual(IMPLEMENTOR_STAGES, ["implement", "fix", "sync", "checks"]);
  assert.equal(roleOf("checks")?.name, "implementor");
  assert.equal(roleOf("implement")?.name, "implementor");
});
