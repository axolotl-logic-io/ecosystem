// @ts-check
// Config `contextLimits` (the soft and hard context limits a writer session
// works to, in tokens) and `maxContinuations` (handoffs each writer stage may
// continue, per issue) default to 175000/225000 and 1 (#269,
// wrap-up-at-175k), and loadConfig refuses limits that are not positive whole
// numbers with soft below hard, and a hard limit at or above a writer's
// context budget, which the watchdog kills it past.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { OpsError } from "../src/process.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-limits-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
let files = 0;
const SEVERAL = 3;
// The default sessionTokenCap, a writer's watchdog budget.
const WRITER_CAP = 300_000;
const BELOW_WRITER_BUDGETS =
  /contextLimits\.hard \(225000\) must be below every writer's context budget, but ciFixer's is 100000/u;

/** @param {object} extra @returns {string} */
function configWith(extra) {
  files += 1;
  const file = path.join(tmp, `config-${files}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      repo: "o/r",
      account: "a",
      allowedUsers: ["a"],
      commands: { test: "true" },
      ...extra,
    }),
  );
  return file;
}

// Whether loading a config with `extra` throws an OpsError naming its file.
/** @param {object} extra @returns {boolean} */
function refuses(extra) {
  const file = configWith(extra);
  try {
    loadConfig(file);
  } catch (err) {
    return err instanceof OpsError && err.message.includes(file);
  }
  return false;
}

test("context limits default to 175000 soft, 225000 hard, one continuation, below the 300000 writer cap", () => {
  const cfg = loadConfig(configWith({}));
  assert.deepEqual(cfg.contextLimits, { soft: 175_000, hard: 225_000 });
  assert.equal(cfg.maxContinuations, 1);
  const { sessionTokenCap } = cfg;
  assert.equal(sessionTokenCap, WRITER_CAP);
});

test("a hard limit at or above a writer's context budget is refused, naming the role", () => {
  const writerBudgets = [
    { sessionTokenCap: 225_000 },
    { sessionTokenCap: 200_000 },
    { roleBudgets: { implementer: 225_000 } },
    { roleBudgets: { fixer: 200_000 } },
    { roleBudgets: { ciFixer: 100_000 } },
  ];
  for (const bad of writerBudgets) {
    assert.ok(refuses(bad), JSON.stringify(bad));
  }
  assert.throws(
    () => loadConfig(configWith({ roleBudgets: { ciFixer: 100_000 } })),
    BELOW_WRITER_BUDGETS,
  );
});

test("a hard limit below every writer's budget loads, whatever a reader's budget is", () => {
  const cfg = loadConfig(
    configWith({
      sessionTokenCap: 300_000,
      roleBudgets: { implementer: 300_000, triage: 50_000, spec: 200_000 },
      contextLimits: { soft: 175_000, hard: 225_000 },
    }),
  );
  assert.deepEqual(cfg.contextLimits, { soft: 175_000, hard: 225_000 });
});

test("other positive limits with soft below hard are kept", () => {
  const cfg = loadConfig(
    configWith({
      contextLimits: { soft: 90_000, hard: 120_000 },
      maxContinuations: 0,
    }),
  );
  assert.deepEqual(cfg.contextLimits, { soft: 90_000, hard: 120_000 });
  assert.equal(cfg.maxContinuations, 0);
  assert.equal(
    loadConfig(configWith({ maxContinuations: SEVERAL })).maxContinuations,
    SEVERAL,
  );
});

test("bad context limits throw naming the config file", () => {
  for (const bad of [
    { contextLimits: { soft: 175_000, hard: 175_000 } },
    { contextLimits: { soft: 180_000, hard: 175_000 } },
    { contextLimits: { soft: 150_000 } },
    { contextLimits: { soft: 0, hard: 175_000 } },
    { contextLimits: { soft: 1.5, hard: 175_000 } },
    { maxContinuations: -1 },
    { maxContinuations: 0.5 },
  ]) {
    assert.ok(refuses(bad), JSON.stringify(bad));
  }
});
