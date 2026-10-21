// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { git, policyFixture } from "./project-policy-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");
const { assertPolicyDigest, configPolicyDigest } = await import(
  "../src/project-policy.ts"
);
const { parseProjectSettings } = await import(
  "../src/project-policy-schema.ts"
);
const NOT_REGULAR = /committed regular file/u;
const NOT_COMMIT = /must name a commit/u;
const WRONG_ORIGIN = /configured repository origin/u;
const COMPUTED_BINDING = /computed/u;
const POLICY_CHANGED = /changed since this job/u;
const REPEATED_FIELD = /project policy repeats field/u;
const UNKNOWN_KEY = /Unrecognized key/u;
const DIGEST_LENGTH = 64;

for (const kind of ["directory", "gitlink"]) {
  test(`a committed ${kind} cannot supply project policy`, () => {
    const fx = policyFixture();
    git(fx.dir, ["rm", ".issue-pipeline.json"]);
    if (kind === "directory") {
      const dir = path.join(fx.dir, ".issue-pipeline.json");
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, "policy.json"),
        '{"commands":{"test":"true"}}',
      );
      git(fx.dir, ["add", ".issue-pipeline.json"]);
    } else {
      git(fx.dir, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${fx.revision},.issue-pipeline.json`,
      ]);
    }
    git(fx.dir, ["commit", "--quiet", "-m", "nonblob policy"]);
    fx.save({
      projectPolicy: {
        repository: fx.dir,
        revision: git(fx.dir, ["rev-parse", "HEAD"]),
      },
    });
    assert.throws(() => loadConfig(fx.file), NOT_REGULAR);
  });
}

test("a full annotated-tag object ID cannot stand in for a pinned commit", () => {
  const fx = policyFixture();
  git(fx.dir, ["tag", "-a", "policy-tag", "-m", "not a commit"]);
  fx.save({
    projectPolicy: {
      repository: fx.dir,
      revision: git(fx.dir, ["rev-parse", "policy-tag"]),
    },
  });
  assert.throws(() => loadConfig(fx.file), NOT_COMMIT);
});

test("multiple source origins refuse even when each names the configured repository", () => {
  const fx = policyFixture();
  git(fx.dir, [
    "config",
    "--add",
    "remote.origin.url",
    "https://github.com/example/repo.git",
  ]);
  assert.throws(() => loadConfig(fx.file), WRONG_ORIGIN);
});

const EXPECTED_ORIGIN = "https://github.com/example/repo.git";
for (const origins of [
  [EXPECTED_ORIGIN, ""],
  ["", EXPECTED_ORIGIN],
  [EXPECTED_ORIGIN, " \t"],
  [" \t", EXPECTED_ORIGIN],
  [` ${EXPECTED_ORIGIN}`],
  [`${EXPECTED_ORIGIN} `],
]) {
  test(`blank or padded source origins refuse: ${JSON.stringify(origins)}`, () => {
    const fx = policyFixture();
    git(fx.dir, ["config", "--unset-all", "remote.origin.url"]);
    for (const origin of origins) {
      git(fx.dir, ["config", "--add", "remote.origin.url", origin]);
    }
    assert.throws(() => loadConfig(fx.file), WRONG_ORIGIN);
  });
}

test("moving source HEAD to weaker committed commands does not activate them", () => {
  const fx = policyFixture();
  const before = loadConfig(fx.file);
  fs.writeFileSync(
    path.join(fx.dir, ".issue-pipeline.json"),
    '{"commands":{"test":"true"}}',
  );
  git(fx.dir, ["add", ".issue-pipeline.json"]);
  git(fx.dir, ["commit", "--quiet", "-m", "untrusted policy movement"]);
  const after = loadConfig(fx.file);
  assert.equal(after.commands.test, "printf checked");
  assert.deepEqual(after.policyBinding, before.policyBinding);
  assert.equal(after.projectPolicy?.revision, fx.revision);
});

test("flat operator policy ignores even malformed candidate policy and computes its own digest", () => {
  const fx = policyFixture();
  const { projectPolicy: _source, ...operator } = fx.operator;
  fs.writeFileSync(
    fx.file,
    JSON.stringify({ ...operator, commands: { test: "printf operator" } }),
  );
  const before = loadConfig(fx.file);
  fs.writeFileSync(path.join(fx.dir, ".issue-pipeline.json"), "not JSON");
  const after = loadConfig(fx.file);
  assert.equal(after.commands.test, "printf operator");
  assert.equal(after.policyBinding?.mode, "legacy");
  assert.equal(configPolicyDigest(after), configPolicyDigest(before));
  assert.throws(
    () => assertPolicyDigest(after, "0".repeat(DIGEST_LENGTH)),
    POLICY_CHANGED,
  );
  fs.writeFileSync(
    fx.file,
    JSON.stringify({
      ...operator,
      commands: { test: "printf operator" },
      policyBinding: before.policyBinding,
    }),
  );
  assert.throws(() => loadConfig(fx.file), COMPUTED_BINDING);
});

for (const settings of [
  { lockfiles: [{ path: "lock", regenerate: "true", tokenEnv: "FORBIDDEN" }] },
  {
    migrations: { pathGlobs: ["migrations/**"], up: "true", requireCi: false },
  },
]) {
  test(`nested project settings reject unknown authority: ${JSON.stringify(settings)}`, () => {
    assert.throws(
      () =>
        parseProjectSettings(
          JSON.stringify({ commands: { test: "true" }, ...settings }),
        ),
      UNKNOWN_KEY,
    );
  });
}

for (const document of [
  '{"commands":{"test":"true"},"lockfiles":[{"path":"a","regenerate":"true","path":"b"}]}',
  '{"commands":{"test":"true"},"migrations":{"pathGlobs":["migrations/**"],"up":"trusted","\\u0075p":"weakened"}}',
]) {
  test(`nested duplicate members cannot select a last policy value: ${document}`, () => {
    assert.throws(() => parseProjectSettings(document), REPEATED_FIELD);
  });
}

test("duplicate detection keeps separate array-object member scopes", () => {
  const settings = {
    commands: { test: "true" },
    lockfiles: [
      { path: "one.lock", regenerate: "printf one" },
      { path: "two.lock", regenerate: "printf two" },
    ],
  };
  assert.deepEqual(parseProjectSettings(JSON.stringify(settings)), settings);
});
