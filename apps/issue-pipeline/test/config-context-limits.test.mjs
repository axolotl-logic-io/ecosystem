// @ts-check
// Config `contextLimits` (the soft and hard context limits a writer session
// works to, in tokens) and `maxContinuations` (handoffs each writer stage may
// continue, per issue) default to 150000/175000 and 1 (#269), and loadConfig
// refuses limits that are not positive whole numbers with soft below hard.
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

test("context limits default to 150000 soft, 175000 hard, one continuation", () => {
  const cfg = loadConfig(configWith({}));
  assert.deepEqual(cfg.contextLimits, { soft: 150_000, hard: 175_000 });
  assert.equal(cfg.maxContinuations, 1);
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
