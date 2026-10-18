// @ts-check
// Budgets bound context, not spend (budgets-bound-context, Axlog,
// 2026-10-16): a config that still sets the removed issueTokenBudget and
// rebaseTokenBudget loads. tokensPerHour, the orchestrator's hourly rate
// limit, went with the session budgets (src/config-legacy.ts): a config that
// sets it loads with a warning, and it never reaches the loaded config, so
// nothing limits the hour's tokens (it replaces the tests that it defaulted
// to null and could be set).
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { testConfig } = await import("./config-test-kit.mjs");

const HOURLY = 500_000;
const ISSUE_BUDGET = 1_000_000;
const REMOVAL = "session budgets and handoffs were removed";

test("a config that still sets issueTokenBudget and rebaseTokenBudget loads", () => {
  const { cfg } = testConfig({
    issueTokenBudget: ISSUE_BUDGET,
    rebaseTokenBudget: HOURLY,
  });
  assert.equal(cfg.repo, "example/repo");
  assert.equal("issueTokenBudget" in cfg, false);
  assert.equal("rebaseTokenBudget" in cfg, false);
});

test("a config that sets tokensPerHour loads, warning that it is no longer read", () => {
  const { cfg, warnings } = testConfig({ tokensPerHour: HOURLY });
  assert.equal("tokensPerHour" in cfg, false);
  assert.ok(
    warnings.some((line) =>
      line.includes(`tokensPerHour is no longer read (${REMOVAL})`),
    ),
    warnings.join(""),
  );
});

test("a config without tokensPerHour has none", () => {
  const { cfg } = testConfig({});
  assert.equal("tokensPerHour" in cfg, false);
});
