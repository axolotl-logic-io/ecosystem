// The stage job's roles: which role each stage and each session runs as, the
// roles' merged settings, and the environment a session's pi gets.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentEnvOf,
  boundaryOf,
  rolesOf,
  sessionRoleOf,
} from "../src/job/roles.ts";
import { STAGE_ORDER } from "../src/workflow/sweep-config.ts";

// The stages each role runs, as the wiki's Issue-Pipeline "Job boundaries"
// lists them under "Roles".
/** @typedef {import("../src/workflow/stages/types.ts").StageName} StageName */
/** @type {StageName[]} */
const READER_STAGES = ["triage", "spec", "review", "accept", "security"];
/** @type {StageName[]} */
const WRITER_STAGES = ["implement", "fix", "open-pr", "sync", "checks"];
/** @type {StageName[]} */
const MERGER_STAGES = ["merge", "publish"];

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

const JOB_ROLES = {
  writer: { tokenEnv: "W_TOKEN" },
  merger: { tokenEnv: "M_TOKEN" },
};
const CONFIGURED = rolesOf(JOB_ROLES);
const ISSUE = 7;

/** @type {import("../src/config.ts").Config} */
const CFG = {
  account: "a",
  allowedUsers: ["a"],
  baseBranch: "integration",
  claimWaitSeconds: [0, 0],
  commands: { test: "true" },
  contextLimits: { soft: 150_000, hard: 175_000 },
  jobRoles: JOB_ROLES,
  leaseHours: 1,
  maxContinuations: 1,
  practices: [],
  repo: "o/r",
  slug: "o__r",
};

test("each stage's boundary has the wiki's role, and only writer and merger stages get GH_TOKEN", () => {
  /** @type {[StageName[], string, boolean][]} */
  const groups = [
    [READER_STAGES, "reader", false],
    [WRITER_STAGES, "writer", true],
    [MERGER_STAGES, "merger", true],
  ];
  for (const [stages, role, token] of groups) {
    for (const stage of stages) {
      const boundary = boundaryOf(CFG, ISSUE, stage, FROM);
      assert.equal(boundary.role, role, stage);
      assert.equal(boundary.env.includes("GH_TOKEN"), token, stage);
    }
  }
  const listed = [...READER_STAGES, ...WRITER_STAGES, ...MERGER_STAGES];
  assert.equal(listed.length, STAGE_ORDER.length);
  assert.deepEqual(new Set(listed), new Set(STAGE_ORDER));
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
