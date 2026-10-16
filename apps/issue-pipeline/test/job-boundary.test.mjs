// The stage job's boundaries, end to end through job-test-kit.mjs: the env
// each pi session gets for its role, and what --print-boundary declares.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  piStarts,
  repliesAt,
  runJob,
  SPEC_SESSION,
  setUp,
} from "./job-test-kit.mjs";

const NAMES_JOB_ROLES = /jobRoles/u;
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
const EXPECTED = {
  spec: { role: "reader", network: ["api.anthropic.com"], token: false },
  implement: { role: "writer", network: ["example.com"], token: true },
  merge: { role: "merger", network: ["api.github.com"], token: true },
};

/** @param {readonly string[]} names @returns {boolean} */
function isSorted(names) {
  return names.every((name, at) => at === 0 || (names[at - 1] ?? "") < name);
}

/** @param {object} jobRoles @param {string} stage */
function placeAt(jobRoles, stage) {
  return setUp(repliesAt(stage), SPEC_SESSION, { jobRoles });
}

test("a reader session's pi gets none of the gh token variables nor a role's token", () => {
  const place = placeAt({ writer: { tokenEnv: "W_TOKEN" } }, "spec");
  const r = runJob(place, ["--stage", "spec"], TOKENS_ENV);
  assert.equal(r.status, 0, r.stderr);
  const [start] = piStarts(place);
  for (const name of [...GH_VARS, "W_TOKEN"]) {
    assert.ok(!start.env.includes(name), name);
  }
  assert.ok(start.env.includes("PATH"));
  assert.equal(start.ghToken, null);
});

test("a writer session's pi gets GH_TOKEN from the writer's tokenEnv only", () => {
  const place = placeAt({ writer: { tokenEnv: "W_TOKEN" } }, "implement");
  runJob(place, ["--stage", "implement"], TOKENS_ENV);
  const [start] = piStarts(place);
  assert.equal(start.ghToken, "w-secret");
  assert.ok(!start.env.includes("W_TOKEN"));
  assert.ok(!start.env.includes("GITHUB_TOKEN"));
});

test("a writer with no tokenEnv gets no GH_TOKEN, even when the job has one", () => {
  const place = placeAt({}, "implement");
  runJob(place, ["--stage", "implement"], GH_ENV);
  const [start] = piStarts(place);
  assert.equal(start.ghToken, null);
  assert.ok(!start.env.includes("GH_TOKEN"));
});

for (const [stage, expected] of Object.entries(EXPECTED)) {
  test(`--print-boundary declares the ${stage} stage's boundary and starts nothing`, () => {
    const place = placeAt(BOUNDARY_ROLES, stage);
    const r = runJob(place, ["--stage", stage, "--print-boundary"], SECRETS);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const boundary = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(boundary), [
      "role",
      "checkout",
      "env",
      "network",
    ]);
    assert.equal(boundary.role, expected.role);
    assert.equal(boundary.checkout, path.join(place.root, "work/o__r/issue-7"));
    assert.deepEqual(boundary.network, expected.network);
    assert.ok(isSorted(boundary.env));
    assert.ok(
      boundary.env.every(
        (/** @type {unknown} */ name) => typeof name === "string",
      ),
    );
    assert.equal(boundary.env.includes("GH_TOKEN"), expected.token);
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
  const place = placeAt({}, "spec");
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
  const place = placeAt({ writer: { tokenEnv: "bad name" } }, "spec");
  const r = runJob(place, ["--stage", "spec", "--print-boundary"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, NAMES_JOB_ROLES);
  assert.equal(r.stdout, "");
});
