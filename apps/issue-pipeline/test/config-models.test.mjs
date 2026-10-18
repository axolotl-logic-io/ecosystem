// @ts-check
// The three model roles' models (`three-configurable-models`): each role's own
// key, else the installed version's roles it maps from, else the default; and
// removed keys load with a warning rather than failing.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { testConfig } = await import("./config-test-kit.mjs");

const { chooseModels } = await import("../src/config-legacy.ts");

const DEFAULT_MODEL = "openai/gpt-6.1-sol";
const SOFT = 1;
const HARD = 2;
// The removed claim race waited this many seconds before and after posting.
const FIRST_WAIT = 5;
const SECOND_WAIT = 20;
const WAITS = [FIRST_WAIT, SECOND_WAIT];

test("each role's own key wins over the installed version's roles", () => {
  const { models } = chooseModels({ author: "a", spec: "s", reviewer: "r" });
  assert.deepEqual(models, {
    author: "a",
    implementor: DEFAULT_MODEL,
    reviewer: "r",
  });
});

test("installed-version roles map to the new roles in their documented order", () => {
  const { models, warnings } = chooseModels({
    triage: "t",
    spec: "s",
    fixer: "f",
    implementer: "i",
    security: "sec",
    scope: "sonnet",
  });
  assert.deepEqual(models, { author: "s", implementor: "i", reviewer: "sec" });
  assert.ok(warnings.some((line) => line.includes("models.spec")));
  assert.ok(
    warnings.some((line) => line.includes("models.scope is no longer read")),
  );
  assert.ok(
    warnings.some((line) => line.includes("models.triage is no longer read")),
  );
});

test("no models at all gives every role the OpenAI default", () => {
  assert.deepEqual(chooseModels(undefined).models, {
    author: DEFAULT_MODEL,
    implementor: DEFAULT_MODEL,
    reviewer: DEFAULT_MODEL,
  });
});

test("a config with removed keys loads, warning once for each", () => {
  const { cfg, warnings } = testConfig({
    contextLimits: { soft: SOFT, hard: HARD },
    maxFixRounds: 2,
    roleBudgets: {},
    claimWaitSeconds: WAITS,
    escalationAgentActs: true,
    models: { scope: "anthropic/claude-sonnet-5-5" },
  });
  assert.equal(cfg.models.reviewer, DEFAULT_MODEL);
  for (const key of [
    "contextLimits",
    "maxFixRounds",
    "roleBudgets",
    "claimWaitSeconds",
    "escalationAgentActs",
  ]) {
    assert.ok(
      warnings.some((line) => line.includes(`${key} is no longer read`)),
      key,
    );
    assert.equal(key in cfg, false);
  }
});

test("explicit models survive the default switch without a fallback", () => {
  const configured = {
    author: "custom/a",
    implementor: "anthropic/explicit",
    reviewer: "custom/r",
  };
  assert.deepEqual(chooseModels(configured), {
    models: configured,
    warnings: [],
  });
});
