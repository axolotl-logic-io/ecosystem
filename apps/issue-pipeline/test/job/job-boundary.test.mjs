// @ts-check
// The stage job's boundaries, end to end through job-test-kit.mjs: the env
// each pi session gets for its role, and what --print-boundary declares, for
// the four stages: the author reads, the implementor and the reviewer (whose
// hardening commits) write, and the merge holds the merge's credentials
// while its integration sessions commit without them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  AUTHOR_SESSION,
  IMPLEMENTOR_SESSION,
  implementReplies,
  READER_STAGE,
  repliesAt,
} from "../job-fixtures.mjs";
import { checkoutOf } from "../job-git-test-kit.mjs";
import {
  piStarts,
  runJob,
  sessionOf,
  setUp,
  statusOf,
} from "./job-test-kit.mjs";

const { loadConfig } = await import("../../src/config.ts");
const { runtimeBoundary } = await import("../../src/job/runtime-policy.ts");

const NAMES_JOB_ROLES = /jobRoles/u;
const NAMES_TOOLCHAIN = /runtime\.toolchainEnv/u;
// The compaction policy the fixture's 272,000-token model window yields.
const FIXTURE_COMPACTION = {
  targetTokens: 175_000,
  reserveTokens: 97_000,
  keepRecentTokens: 30_000,
};
const STEER_BOUNDARY = /--steer can't be combined with --print-boundary/u;
const GH_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];
// Every gh token variable, each with its own secret.
const GH_ENV = Object.fromEntries(
  GH_VARS.map((name) => [name, `${name.toLowerCase()}-secret`]),
);
const SECRETS = Object.fromEntries([
  ["GH_TOKEN", "gh-secret"],
  ["W_TOKEN", "w-secret"],
  ["M_TOKEN", "m-secret"],
]);
// The job env with every gh token variable and the writer's token set.
const TOKENS_ENV = {
  ...GH_ENV,
  ...Object.fromEntries([["W_TOKEN", "w-secret"]]),
};
const BOUNDARY_ROLES = {
  writer: { tokenEnv: "W_TOKEN", network: ["example.com"] },
  merger: { tokenEnv: "M_TOKEN" },
};
// Each stage's role, network and access to its code (repo/)
// checkout: the author only reads it; every other stage writes it.
const WRITER = {
  role: "writer",
  network: ["example.com"],
  access: { repo: "write" },
};
const EXPECTED = {
  author: {
    role: "reader",
    network: ["api.anthropic.com"],
    access: { repo: "read" },
  },
  implement: WRITER,
  review: WRITER,
  // Merge lands and completes; its only session, Security, reads (#186).
  merge: {
    role: "merger",
    network: ["api.github.com", "api.anthropic.com", "registry.npmjs.org"],
    access: { repo: "read" },
  },
};
const COMMIT_EXTENSION = /\/pipeline-commit\.mjs$/u;
// A --tools entry that adds a tool to pi's defaults starts with "+".
const ADDED_TOOL = /^\+/u;
const COMMIT_SCOPE_ENV = "ISSUE_PIPELINE_COMMIT_SCOPE";

// The extensions pi's `argv` loads.
/** @param {string[]} argv @returns {string[]} */
function extensionsOf(argv) {
  return argv.filter((_, at) => argv[at - 1] === "-e");
}

// The tools pi's `argv` names in --tools, without a leading "+".
/** @param {string[]} argv @returns {string[]} */
function toolsOf(argv) {
  const list = argv[argv.indexOf("--tools") + 1] ?? "";
  return list.split(",").map((tool) => tool.replace(ADDED_TOOL, ""));
}

/** @param {readonly string[]} names @returns {boolean} */
function isSorted(names) {
  return names.every((name, at) => at === 0 || (names[at - 1] ?? "") < name);
}

// A `stage` job whose config has `jobRoles`: the implementor's ops and
// session at implement, the author's at every other stage.
/** @param {object} jobRoles @param {string} stage */
function placeAt(jobRoles, stage) {
  if (stage === "implement") {
    return setUp(implementReplies(), IMPLEMENTOR_SESSION, { jobRoles });
  }
  return setUp(repliesAt(stage), AUTHOR_SESSION, { jobRoles });
}

test("a writer session's pi loads pipeline_commit with its commit scope, and job.json records it committing", () => {
  const place = placeAt({ writer: { tokenEnv: "W_TOKEN" } }, "implement");
  const end = runJob(place, ["--stage", "implement"], TOKENS_ENV);
  assert.equal(end.status, 0, end.stderr);
  const [start] = piStarts(place);
  assert.equal(start.ghToken, null);
  for (const name of [...GH_VARS, "W_TOKEN"]) {
    assert.equal(start.env.includes(name), false, name);
  }
  assert.ok(
    extensionsOf(start.argv).some((file) => COMMIT_EXTENSION.test(file)),
  );
  assert.ok(toolsOf(start.argv).includes("pipeline_commit"));
  assert.ok(start.env.includes(COMMIT_SCOPE_ENV));
  const session = sessionOf(statusOf(place));
  assert.deepEqual([session.commits, session.phase], [true, null]);
});

test("a reader session's pi gets neither pipeline_commit, a commit scope nor a tool that writes, and job.json records it read-only", () => {
  const place = placeAt({ writer: { tokenEnv: "W_TOKEN" } }, READER_STAGE);
  const end = runJob(place, ["--stage", READER_STAGE], TOKENS_ENV);
  assert.equal(end.status, 0, end.stderr);
  const [start] = piStarts(place);
  assert.equal(start.ghToken, null);
  assert.ok(start.env.includes("PATH"));
  for (const name of [...GH_VARS, "W_TOKEN"]) {
    assert.equal(start.env.includes(name), false, name);
  }
  assert.ok(
    !extensionsOf(start.argv).some((file) => COMMIT_EXTENSION.test(file)),
  );
  for (const tool of ["pipeline_commit", "bash", "edit", "write"]) {
    assert.ok(!toolsOf(start.argv).includes(tool), tool);
  }
  assert.ok(!start.env.includes(COMMIT_SCOPE_ENV));
  const session = sessionOf(statusOf(place));
  assert.deepEqual([session.commits, session.phase], [false, null]);
});

for (const [stage, expected] of Object.entries(EXPECTED)) {
  test(`--print-boundary declares the ${stage} stage's boundary and starts nothing`, () => {
    const place = placeAt(BOUNDARY_ROLES, stage);
    const r = runJob(place, ["--stage", stage, "--print-boundary"], SECRETS);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const boundary = JSON.parse(r.stdout);
    // The boundary contract promises these fields, not their order.
    assert.deepEqual(
      new Set(Object.keys(boundary)),
      new Set(["role", "checkout", "access", "env", "network", "runtime"]),
    );
    const config = loadConfig(place.config);
    assert.deepEqual(
      boundary.runtime,
      runtimeBoundary(config.runtime, config.models),
    );
    assert.equal(boundary.role, expected.role);
    assert.deepEqual(boundary.access, expected.access);
    assert.equal(boundary.checkout, checkoutOf(place.root, stage));
    assert.ok(!fs.existsSync(boundary.checkout));
    assert.deepEqual(boundary.network, expected.network);
    assert.ok(isSorted(boundary.env));
    assert.ok(
      boundary.env.every(
        (/** @type {unknown} */ name) => typeof name === "string",
      ),
    );
    for (const name of GH_VARS) {
      assert.ok(!boundary.env.includes(name), name);
    }
    assert.ok(!boundary.env.includes("W_TOKEN"));
    assert.ok(!boundary.env.includes("M_TOKEN"));
    assert.ok(boundary.env.includes("PATH"));
    for (const secret of Object.values(SECRETS)) {
      assert.ok(!r.stdout.includes(secret), secret);
    }
    assert.ok(!fs.existsSync(path.join(place.root, "ops.log")));
    assert.ok(!fs.existsSync(path.join(place.root, "pi.log")));
    assert.ok(!fs.existsSync(path.join(place.runDir, "job.json")));
  });
}

test("--print-boundary with --steer is refused", () => {
  const place = placeAt({}, READER_STAGE);
  const r = runJob(place, [
    "--print-boundary",
    "--steer",
    "k",
    "--message",
    "m",
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, STEER_BOUNDARY);
  assert.equal(r.stdout, "");
});

test("a malformed jobRoles fails the job, naming jobRoles", () => {
  const place = placeAt({ writer: { tokenEnv: "bad name" } }, READER_STAGE);
  const r = runJob(place, ["--stage", READER_STAGE, "--print-boundary"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, NAMES_JOB_ROLES);
  assert.equal(r.stdout, "");
});

test("--print-boundary names the complete nonsecret runtime policy for every model role", () => {
  const place = placeAt(BOUNDARY_ROLES, READER_STAGE);
  const r = runJob(
    place,
    ["--stage", READER_STAGE, "--print-boundary"],
    SECRETS,
  );
  assert.equal(r.status, 0, r.stderr);
  const { runtime } = JSON.parse(r.stdout);
  assert.deepEqual(runtime.credentialEnv, ["PIPELINE_MODEL_KEY"]);
  assert.deepEqual(
    runtime.policies.map((/** @type {{ role: string }} */ { role }) => role),
    ["author", "implementor", "reviewer"],
  );
  for (const {
    targetTokens,
    reserveTokens,
    keepRecentTokens,
  } of runtime.policies) {
    assert.deepEqual(
      { targetTokens, reserveTokens, keepRecentTokens },
      FIXTURE_COMPACTION,
    );
  }
  for (const secret of Object.values(SECRETS)) {
    assert.equal(r.stdout.includes(secret), false, secret);
  }
});

/** The reader stage's job, with `toolchainEnv` declared in its config. @param {Record<string, string>} toolchainEnv */
function withToolchain(toolchainEnv) {
  const place = placeAt(BOUNDARY_ROLES, READER_STAGE);
  const config = JSON.parse(fs.readFileSync(place.config, "utf8"));
  config.runtime.toolchainEnv = toolchainEnv;
  fs.writeFileSync(place.config, JSON.stringify(config));
  return runJob(place, ["--stage", READER_STAGE, "--print-boundary"], SECRETS);
}

test("--print-boundary names the declared runtime toolchain", () => {
  const toolchainEnv = Object.fromEntries([
    ["PATH", "/opt/node/bin:/usr/bin"],
    ["MISE_DATA_DIR", "/opt/mise"],
  ]);
  const r = withToolchain(toolchainEnv);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).runtime.toolchainEnv, toolchainEnv);
});

for (const [name, value] of [
  ["HOME", "/elsewhere"],
  ["GH_TOKEN", "synthetic"],
  ["OPENAI_API_KEY", "synthetic"],
  ["PATH", "relative:/bin"],
  ["PATH", "/bin:"],
  ["MISE_STATE_DIR", "~/state"],
]) {
  test(`a job refuses a toolchain declaring ${name} as ${value}, naming it and starting nothing`, () => {
    const r = withToolchain(Object.fromEntries([[name, value]]));
    assert.equal(r.status, 1);
    assert.match(r.stderr, NAMES_TOOLCHAIN);
    assert.equal(r.stdout, "");
  });
}
