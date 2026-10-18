// @ts-check
// Session budgets and handoffs were removed (src/config-legacy.ts's
// REMOVED_FIELDS): the context limits a writer worked to (`contextLimits`,
// #269), the handoffs it could continue (`maxContinuations`) and the context
// budgets the watchdog held it to (`sessionTokenCap`, `roleBudgets`, #335).
// What replaces the tests of their defaults and refusals: a config written
// for the installed version still loads, whatever it set them to, even the
// values loadConfig once refused; each is named in a warning saying why it
// is no longer read; and none reaches the loaded config.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { testConfig } = await import("./config-test-kit.mjs");

const REMOVAL = "session budgets and handoffs were removed";
const SOFT = 175_000;
const HARD = 225_000;
const WRITER_CAP = 300_000;
const CI_FIXER_BUDGET = 100_000;
const SEVERAL = 3;

// What is wrong with how a config setting the `removed` keys loads: a key
// with no warning naming its removal, or one the loaded config still has.
/** @param {Record<string, unknown>} removed @returns {string[]} */
function ignoredProblems(removed) {
  const { cfg, warnings } = testConfig(removed);
  /** @type {string[]} */
  const problems = [];
  for (const key of Object.keys(removed)) {
    const warned = warnings.some((line) =>
      line.includes(`${key} is no longer read (${REMOVAL})`),
    );
    if (!warned) {
      problems.push(`${key} has no warning`);
    }
    if (key in cfg) {
      problems.push(`${key} is in the config`);
    }
  }
  return problems;
}

test("a config that sets the removed context limits, continuations and budgets loads, warning for each", () => {
  const problems = ignoredProblems({
    contextLimits: { soft: SOFT, hard: HARD },
    maxContinuations: SEVERAL,
    sessionTokenCap: WRITER_CAP,
    roleBudgets: { implementer: WRITER_CAP },
  });
  assert.deepEqual(problems, []);
});

test("values loadConfig once refused no longer stop a config loading", () => {
  const once = [
    { contextLimits: { soft: HARD, hard: SOFT } },
    { contextLimits: { soft: 0 } },
    { maxContinuations: -1 },
    { sessionTokenCap: HARD, contextLimits: { soft: SOFT, hard: HARD } },
    { roleBudgets: { ciFixer: CI_FIXER_BUDGET } },
  ];
  assert.deepEqual(once.flatMap(ignoredProblems), []);
});

test("a config without them loads with no warning", () => {
  const { cfg, warnings } = testConfig({});
  assert.deepEqual(warnings, []);
  for (const key of [
    "contextLimits",
    "maxContinuations",
    "sessionTokenCap",
    "roleBudgets",
  ]) {
    assert.equal(key in cfg, false, key);
  }
});
