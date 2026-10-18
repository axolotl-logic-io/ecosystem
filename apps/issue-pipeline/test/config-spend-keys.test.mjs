// @ts-check
// Budgets bound context, not spend (budgets-bound-context, Axlog, 2026-10-16):
// a config that still sets the removed issueTokenBudget and rebaseTokenBudget
// loads, and tokensPerHour, the orchestrator's hourly rate limit, is off
// (null) unless a config sets it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-spend-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
let files = 0;
const HOURLY = 500_000;

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

test("a config that still sets issueTokenBudget and rebaseTokenBudget loads", () => {
  const cfg = loadConfig(
    configWith({ issueTokenBudget: 1_000_000, rebaseTokenBudget: 500_000 }),
  );
  assert.equal(cfg.repo, "o/r");
});

test("tokensPerHour defaults to null, no rate limit", () => {
  const { tokensPerHour } = loadConfig(configWith({}));
  assert.equal(tokensPerHour, null);
});

test("a config can still set tokensPerHour", () => {
  const { tokensPerHour } = loadConfig(configWith({ tokensPerHour: HOURLY }));
  assert.equal(tokensPerHour, HOURLY);
});
