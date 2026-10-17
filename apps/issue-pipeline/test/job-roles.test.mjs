// The stage job's roles: which role each stage and each session runs as,
// each stage's wiki access, the roles' merged settings, and the environment a
// session's pi gets, which holds no token (Pipeline-Roles-Shared, "No token
// in sessions").
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentEnvOf,
  boundaryOf,
  rolesOf,
  STAGE_WIKI_ACCESS,
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
  issueTokenBudget: 1_000_000,
  usageFlags: { firstContext: 40_000, toolOutputShare: 0.25 },
  practices: [],
  repo: "o/r",
  slug: "o__r",
};

test("each stage's boundary has the wiki's role, and no stage's session env names a token", () => {
  /** @type {[StageName[], string][]} */
  const groups = [
    [READER_STAGES, "reader"],
    [WRITER_STAGES, "writer"],
    [MERGER_STAGES, "merger"],
  ];
  for (const [stages, role] of groups) {
    for (const stage of stages) {
      const boundary = boundaryOf(CFG, ISSUE, stage, FROM);
      assert.equal(boundary.role, role, stage);
      for (const name of [...GH_VARS, "W_TOKEN", "M_TOKEN"]) {
        assert.equal(boundary.env.includes(name), false, `${stage} ${name}`);
      }
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

test("no session env holds a gh token variable or any role's tokenEnv", () => {
  assert.deepEqual(agentEnvOf(CONFIGURED, FROM), PLAIN);
  const values = Object.values(agentEnvOf(CONFIGURED, FROM));
  for (const secret of ["w-secret", "m-secret"]) {
    assert.equal(values.includes(secret), false, secret);
  }
});

test("with no tokenEnv set, the role variables are ordinary and only gh's are hidden", () => {
  const untouched = { ...PLAIN, ...ROLE_TOKENS };
  assert.deepEqual(agentEnvOf(rolesOf({}), FROM), untouched);
});

test("spec, merge and publish write the wiki, and, until the spec writer commits its updates, implement, fix and checks too; every stage has a wiki access", () => {
  const writers = Object.entries(STAGE_WIKI_ACCESS)
    .filter(([, access]) => access === "write")
    .map(([stage]) => stage)
    .sort();
  const bridged = ["checks", "fix", "implement"];
  assert.deepEqual(writers, [...bridged, "merge", "publish", "spec"].sort());
  assert.deepEqual(
    new Set(Object.keys(STAGE_WIKI_ACCESS)),
    new Set(STAGE_ORDER),
  );
  for (const access of Object.values(STAGE_WIKI_ACCESS)) {
    assert.ok(["none", "read", "write"].includes(access), access);
  }
});
