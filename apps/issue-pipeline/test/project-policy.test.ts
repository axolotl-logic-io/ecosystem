import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { git, policyFixture } from "./project-policy-test-kit.ts";

const { loadConfig }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const {
  assertPolicyDigest,
  policyRevision,
}: typeof import("../src/project-policy.ts") = await import(
  "../src/project-policy.ts"
);
const {
  approvalHolds,
  newIssueState,
  sameRevision,
  ISSUE_STATE,
}: typeof import("../src/state.ts") = await import("../src/state.ts");
const { securityRefusal }: typeof import("../src/security-clearance.ts") =
  await import("../src/security-clearance.ts");
const { runChecks }: typeof import("../src/ops/checks.ts") = await import(
  "../src/ops/checks.ts"
);

const ISSUE = 7;
const DIGEST_LENGTH = 64;
const SHA_LENGTH = 40;
const SHORT_SHA_LENGTH = 8;
const UNKNOWN_KEY = /Unrecognized key/u;
const DUPLICATE_SETTING = /must not also appear/u;
const COMPUTED_BINDING = /computed/u;
const MISSING_SECURITY = /no security review/u;
const POLICY_CHANGED = /changed since this job/u;
const WRONG_ORIGIN = /configured repository origin/u;
const NOT_COMMIT = /must name a commit/u;
const NOT_REGULAR = /committed regular file/u;

test("committed settings supply setup and checks; candidate files cannot weaken them", () => {
  const fx = policyFixture({
    commands: {
      setup: "printf setup > setup-proof",
      test: "test -f setup-proof && printf checked > check-proof",
      lint: "true",
      typecheck: "true",
      teardown: "true",
      prune: "true",
    },
    practices: ["AGENTS.md", "docs/coding-practices.md"],
    lockfiles: [{ path: "package-lock.json", regenerate: "true" }],
    migrations: {
      pathGlobs: ["migrations/**"],
      setup: "true",
      up: "true",
      down: "true",
    },
  });
  const cfg = loadConfig(fx.file);
  fs.writeFileSync(
    path.join(fx.dir, ".issue-pipeline.json"),
    JSON.stringify({ commands: { test: "false", setup: "false" } }),
  );
  const later = loadConfig(fx.file);
  assert.deepEqual(later.policyBinding, cfg.policyBinding);
  assert.deepEqual(later.commands, cfg.commands);
  const result = runChecks(later, ISSUE, {
    dir: fx.dir,
    sha: fx.revision,
    changed: [],
  });
  assert.equal(result.pass, true);
  assert.equal(
    fs.readFileSync(path.join(fx.dir, "check-proof"), "utf8"),
    "checked",
  );
  assert.deepEqual(
    result.checks.map((check) => check.id),
    ["setup", "test", "lint", "typecheck"],
  );
  assert.deepEqual(later.practices, ["AGENTS.md", "docs/coding-practices.md"]);
  assert.equal(later.policyBinding?.mode, "committed");
  assertPolicyDigest(later, policyRevision(cfg).policy);
});

test("unknown and operator-owned fields are refused, including nested command keys", () => {
  for (const key of [
    "credentialsEnvFile",
    "allowedUsers",
    "devAccount",
    "mergeAccount",
    "repo",
    "cloneUrl",
    "baseBranch",
    "runtime",
    "models",
    "jobRoles",
    "maxJobs",
    "stageCaps",
    "laneSlots",
    "requireCi",
    "commandTimeoutMinutes",
    "mergeAdmin",
    "projectPolicy",
    "surprise",
  ]) {
    const fx = policyFixture({ commands: { test: "true" }, [key]: false });
    assert.throws(() => loadConfig(fx.file), UNKNOWN_KEY, key);
  }
  const fx = policyFixture({
    commands: { test: "true", credentialsEnvFile: "forbidden" },
  });
  assert.throws(() => loadConfig(fx.file), UNKNOWN_KEY);
});

test("operator and committed project settings cannot provide competing policies", () => {
  const fx = policyFixture();
  for (const key of ["commands", "practices", "lockfiles", "migrations"]) {
    fx.save({ [key]: null });
    assert.throws(() => loadConfig(fx.file), DUPLICATE_SETTING, key);
  }
  fx.save({
    policyBinding: { mode: "legacy", digest: "0".repeat(DIGEST_LENGTH) },
  });
  assert.throws(() => loadConfig(fx.file), COMPUTED_BINDING);
});

test("a moved pin invalidates checks, review and Security across jobs even for identical policy bytes", () => {
  const fx = policyFixture();
  const before = loadConfig(fx.file);
  const reviewed = {
    code: fx.revision,
    inputs: "trusted",
    ...policyRevision(before),
  };
  const saved = {
    ...newIssueState(ISSUE),
    hardened: reviewed,
    security: { revision: reviewed, commentId: 1, finding: null },
  };
  git(fx.dir, ["commit", "--allow-empty", "--quiet", "-m", "new operator pin"]);
  fx.save({
    projectPolicy: {
      repository: fx.dir,
      revision: git(fx.dir, ["rev-parse", "HEAD"]),
    },
  });
  const after = loadConfig(fx.file);
  const current = { ...reviewed, ...policyRevision(after) };
  assert.equal(approvalHolds(saved, reviewed), true);
  assert.equal(approvalHolds(saved, current), false);
  assert.match(securityRefusal(saved, current) ?? "", MISSING_SECURITY);
  assert.throws(
    () => assertPolicyDigest(after, reviewed.policy),
    POLICY_CHANGED,
  );
});

test("legacy operator policy stays local, binds new revisions and preserves old saved evidence", () => {
  const fx = policyFixture();
  const { projectPolicy: _source, ...legacy } = fx.operator;
  fs.writeFileSync(
    fx.file,
    JSON.stringify({ ...legacy, commands: { test: "true" } }),
  );
  const first = loadConfig(fx.file);
  assert.equal(first.policyBinding?.mode, "legacy");
  const historical = { code: fx.revision, inputs: "trusted" };
  const saved = ISSUE_STATE.parse({
    ...newIssueState(ISSUE),
    pr: 1,
    headSha: fx.revision,
    hardened: historical,
    merged: historical,
    codeMerged: { pr: 1, sha: fx.revision },
  });
  assert.deepEqual(saved.hardened, historical);
  assert.deepEqual(saved.merged, historical);
  assert.equal(saved.codeMerged?.sha, fx.revision);
  assert.equal(
    approvalHolds(saved, { ...historical, ...policyRevision(first) }),
    false,
  );
  fs.writeFileSync(
    fx.file,
    JSON.stringify({ ...legacy, commands: { test: "false" } }),
  );
  const second = loadConfig(fx.file);
  assert.equal(
    sameRevision(
      { ...historical, ...policyRevision(first) },
      { ...historical, ...policyRevision(second) },
    ),
    false,
  );
});

test("policy source must be the configured repository and a full commit", () => {
  const fx = policyFixture();
  git(fx.dir, [
    "remote",
    "set-url",
    "origin",
    "https://github.com/other/repo.git",
  ]);
  assert.throws(() => loadConfig(fx.file), WRONG_ORIGIN);
  git(fx.dir, [
    "remote",
    "set-url",
    "origin",
    "https://github.com/example/repo.git",
  ]);
  for (const revision of [
    "HEAD",
    "main",
    fx.revision.slice(0, SHORT_SHA_LENGTH),
    "f".repeat(SHA_LENGTH),
  ]) {
    fx.save({ projectPolicy: { repository: fx.dir, revision } });
    assert.throws(() => loadConfig(fx.file));
  }
  const blob = git(fx.dir, [
    "rev-parse",
    `${fx.revision}:.issue-pipeline.json`,
  ]);
  fx.save({ projectPolicy: { repository: fx.dir, revision: blob } });
  assert.throws(() => loadConfig(fx.file), NOT_COMMIT);
});

test("missing, malformed and symlink policies refuse rather than falling back", () => {
  for (const contents of ["{}", "not json", '{"commands":{"test":""}}']) {
    const fx = policyFixture();
    fs.writeFileSync(path.join(fx.dir, ".issue-pipeline.json"), contents);
    git(fx.dir, ["add", ".issue-pipeline.json"]);
    git(fx.dir, ["commit", "--quiet", "-m", "bad policy"]);
    fx.save({
      projectPolicy: {
        repository: fx.dir,
        revision: git(fx.dir, ["rev-parse", "HEAD"]),
      },
    });
    assert.throws(() => loadConfig(fx.file));
  }
  const fx = policyFixture();
  git(fx.dir, ["rm", ".issue-pipeline.json"]);
  git(fx.dir, ["commit", "--quiet", "-m", "missing policy"]);
  fx.save({
    projectPolicy: {
      repository: fx.dir,
      revision: git(fx.dir, ["rev-parse", "HEAD"]),
    },
  });
  assert.throws(() => loadConfig(fx.file), NOT_REGULAR);
  fs.symlinkSync("candidate.json", path.join(fx.dir, ".issue-pipeline.json"));
  git(fx.dir, ["add", ".issue-pipeline.json"]);
  git(fx.dir, ["commit", "--quiet", "-m", "symlink policy"]);
  fx.save({
    projectPolicy: {
      repository: fx.dir,
      revision: git(fx.dir, ["rev-parse", "HEAD"]),
    },
  });
  assert.throws(() => loadConfig(fx.file), NOT_REGULAR);
});
