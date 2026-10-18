// @ts-check
// The stage job's roles: which role each of the four stages runs as (its
// sessions are job-sessions.test.mjs's), each stage's wiki and code access
// and commit scope, the roles' merged settings, and the environment a session's pi
// gets, which holds no token (Pipeline-Roles-Shared, "No token in sessions").
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

const {
  agentEnvOf,
  boundaryOf,
  commitScopeOf,
  rolesOf,
  STAGE_CODE_ACCESS,
  STAGE_WIKI_ACCESS,
} = await import("../src/job/roles.ts");
const { STAGES } = await import("../src/stages.ts");
const { loadConfig } = await import("../src/config.ts");

const COMMIT_SCOPE_ENV = "ISSUE_PIPELINE_COMMIT_SCOPE";

// The stages each role runs: the author reads, the implementor writes and the
// reviewer writes while it hardens, and merge holds the merge's credentials.
/** @typedef {import("../src/stages.ts").Stage} Stage */
/** @type {Stage[]} */
const READER_STAGES = ["author"];
/** @type {Stage[]} */
const WRITER_STAGES = ["implement", "review"];
/** @type {Stage[]} */
const MERGER_STAGES = ["merge"];

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

// A config as loadConfig reads it, with its defaults, from the isolated root.
const CONFIG_FILE = path.join(isolatedRoot, "o__r.json");
fs.writeFileSync(
  CONFIG_FILE,
  JSON.stringify({
    repo: "o/r",
    account: "a",
    allowedUsers: ["a"],
    commands: { test: "true" },
    jobRoles: JOB_ROLES,
  }),
);
const CFG = loadConfig(CONFIG_FILE);

test("each stage's boundary has its role, and no stage's session env names a token", () => {
  /** @type {[Stage[], string][]} */
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
  assert.equal(listed.length, STAGES.length);
  assert.deepEqual(new Set(listed), new Set(STAGES));
});

test("the roles' defaults hold with no config, and a config network replaces one", () => {
  const defaults = rolesOf({});
  assert.deepEqual(defaults.reader.network, ["api.anthropic.com"]);
  assert.deepEqual(defaults.writer.network, [
    "api.anthropic.com",
    "registry.npmjs.org",
  ]);
  assert.deepEqual(defaults.merger.network, [
    "api.github.com",
    "api.anthropic.com",
    "registry.npmjs.org",
  ]);
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

test("no session env inherits a commit scope from the job's own env", () => {
  const scoped = envOf([...Object.entries(PLAIN), [COMMIT_SCOPE_ENV, "{}"]]);
  assert.deepEqual(agentEnvOf(rolesOf({}), scoped), PLAIN);
});

test("only the author reads the wiki alone; implement, review and merge write it", () => {
  const writers = Object.entries(STAGE_WIKI_ACCESS)
    .filter(([, access]) => access === "write")
    .map(([stage]) => stage)
    .sort();
  assert.deepEqual(writers, ["implement", "merge", "review"]);
  for (const stage of READER_STAGES) {
    assert.equal(STAGE_WIKI_ACCESS[stage], "read", stage);
  }
  assert.deepEqual(new Set(Object.keys(STAGE_WIKI_ACCESS)), new Set(STAGES));
});

test("only the author reads the code alone; the writers and merge's integration write it", () => {
  for (const stage of [...WRITER_STAGES, ...MERGER_STAGES]) {
    assert.equal(STAGE_CODE_ACCESS[stage], "write", stage);
  }
  for (const stage of READER_STAGES) {
    assert.equal(STAGE_CODE_ACCESS[stage], "read", stage);
  }
  assert.deepEqual(new Set(Object.keys(STAGE_CODE_ACCESS)), new Set(STAGES));
});

test("a committing session of review or merge may commit any code path and the wiki; the author's scope commits nothing", () => {
  for (const stage of [...WRITER_STAGES, ...MERGER_STAGES]) {
    assert.deepEqual(
      commitScopeOf(stage, true),
      {
        repo: { dir: "repo", access: "write" },
        docs: { dir: "docs", access: "write" },
        allowed: ["**"],
      },
      stage,
    );
  }
  assert.deepEqual(commitScopeOf("author", false), {
    repo: { dir: "repo", access: "read" },
    docs: null,
    allowed: [],
  });
});
