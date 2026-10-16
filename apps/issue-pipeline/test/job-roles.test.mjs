// The stage job's roles: which role each stage and each session runs as, the
// roles' merged settings, and the environment a session's pi gets.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentEnvOf,
  rolesOf,
  STAGE_ROLES,
  sessionRoleOf,
} from "../src/job/roles.ts";
import { STAGE_ORDER } from "../src/workflow/sweep-config.ts";

const EXPECTED_ROLES = {
  triage: "reader",
  spec: "reader",
  implement: "writer",
  "open-pr": "writer",
  review: "reader",
  fix: "writer",
  sync: "writer",
  checks: "writer",
  accept: "reader",
  security: "reader",
  merge: "merger",
};

const GH_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

// An environment of `pairs`, whose names are env variables, not camelCase.
/** @param {[string, string | undefined][]} pairs */
function envOf(pairs) {
  return Object.fromEntries(pairs);
}

const PLAIN = envOf([
  ["PATH", "/bin"],
  ["HOME", "/home/a"],
]);
const ROLE_TOKENS = envOf([
  ["W_TOKEN", "w-secret"],
  ["M_TOKEN", "m-secret"],
]);
// A job environment with every gh token variable and both role tokens set.
const FROM = {
  ...PLAIN,
  ...ROLE_TOKENS,
  ...envOf([["UNSET", undefined]]),
  ...envOf(GH_VARS.map((name) => [name, `${name}-secret`])),
};

const CONFIGURED = rolesOf({
  writer: { tokenEnv: "W_TOKEN" },
  merger: { tokenEnv: "M_TOKEN" },
});

test("every stage runs as the role its table names", () => {
  assert.deepEqual(
    Object.fromEntries(STAGE_ORDER.map((stage) => [stage, STAGE_ROLES[stage]])),
    EXPECTED_ROLES,
  );
  assert.equal(Object.keys(STAGE_ROLES).length, STAGE_ORDER.length);
});

test("only the writer agent's sessions run as writer", () => {
  assert.equal(sessionRoleOf("issue-pipeline-writer"), "writer");
  for (const agent of [
    "issue-pipeline-reader",
    "issue-pipeline-specifier",
    "issue-pipeline-ops",
    "anything",
  ]) {
    assert.equal(sessionRoleOf(agent), "reader", agent);
  }
});

test("the roles' defaults hold with no config, and a config network replaces one", () => {
  const defaults = rolesOf({});
  assert.deepEqual(defaults.reader.network, ["api.anthropic.com"]);
  assert.deepEqual(defaults.writer.network, [
    "api.anthropic.com",
    "registry.npmjs.org",
  ]);
  assert.deepEqual(defaults.merger.network, ["api.github.com"]);
  assert.equal(defaults.writer.tokenEnv, undefined);
  assert.deepEqual(rolesOf(null), defaults);
  const merged = rolesOf({ writer: { network: ["example.com"] } });
  assert.deepEqual(merged.writer.network, ["example.com"]);
  assert.deepEqual(merged.reader.network, ["api.anthropic.com"]);
});

test("a reader's env keeps the job's other variables but no token", () => {
  assert.deepEqual(agentEnvOf("reader", CONFIGURED, FROM), PLAIN);
});

test("a writer's and a merger's GH_TOKEN come from their own tokenEnv", () => {
  assert.deepEqual(
    agentEnvOf("writer", CONFIGURED, FROM),
    envOf([...Object.entries(PLAIN), ["GH_TOKEN", "w-secret"]]),
  );
  assert.deepEqual(
    agentEnvOf("merger", CONFIGURED, FROM),
    envOf([...Object.entries(PLAIN), ["GH_TOKEN", "m-secret"]]),
  );
});

test("a writer with no tokenEnv, or one naming an unset or empty variable, gets no token", () => {
  const untouched = { ...PLAIN, ...ROLE_TOKENS };
  assert.deepEqual(agentEnvOf("writer", rolesOf({}), FROM), untouched);
  const unset = rolesOf({ writer: { tokenEnv: "NOT_SET" } });
  assert.deepEqual(agentEnvOf("writer", unset, FROM), untouched);
  const empty = rolesOf({ writer: { tokenEnv: "EMPTY" } });
  const from = { ...PLAIN, ...envOf([["EMPTY", ""]]) };
  assert.deepEqual(agentEnvOf("writer", empty, from), PLAIN);
});
