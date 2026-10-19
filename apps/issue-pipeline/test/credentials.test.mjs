// @ts-check
// Explicit operator-file identity selection, no ambient fallback or dotenv export.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { credentialConfig } from "./credentials-test-kit.mjs";
import { installFakeGh } from "./fake-gh.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

const { testConfig } = await import("./config-test-kit.mjs");
const { credential, publicConfig } = await import("../src/config.ts");
const { gh, isAllowedUser } = await import("../src/github.ts");
const { childEnvironment } = await import("../src/child-env.ts");
const { run, shell } = await import("../src/process.ts");
const { credentialedRun } = await import("../src/github-auth.ts");
const fake = installFakeGh();
const COMMAND_TIMEOUT_MS = 10_000;
const LEGACY = /legacy account\/tokenFile config is unsupported/u;
const IDENTITIES = /distinct|GitHub username/u;
const ABSOLUTE = /absolute path/u;
const MISSING = /credential file/u;
const VERIFY = /credential login verification failed/u;
const PUBLIC_FILE_MODE = 0o644;
const DEV = "fake-pipeline-dev--dev-bot";
const MERGE = "fake-pipeline-merge--pipeline-bot";

for (const extra of [{ account: "old" }, { tokenFile: "/unused/old-token" }]) {
  test(`legacy live config is rejected: ${Object.keys(extra).join(",")}`, () => {
    assert.throws(() => testConfig(extra), LEGACY);
  });
}

for (const extra of [
  { devAccount: "pipeline-bot" },
  { mergeAccount: "DEV-BOT" },
  { devAccount: "bad/login" },
]) {
  test(`invalid identities are rejected: ${JSON.stringify(extra)}`, () => {
    assert.throws(() => testConfig(extra), IDENTITIES);
  });
}

test("credential path must be absolute and is omitted from public config", () => {
  assert.throws(
    () => testConfig({ credentialsEnvFile: "./operator" }),
    ABSOLUTE,
  );
  const { cfg } = testConfig();
  assert.equal("credentialsEnvFile" in publicConfig(cfg), false);
});

test("only the selected fixed variable is read, never exported or substituted", () => {
  const { cfg } = testConfig(credentialConfig("pipeline-bot"));
  fs.writeFileSync(
    cfg.credentialsEnvFile,
    `ISSUE_PIPELINE_DEV_GITHUB_TOKEN=${DEV}\nUNRELATED_TWO_BOT_TEST=must-not-export\n`,
  );
  assert.equal(credential(cfg, "dev"), DEV);
  assert.throws(() => credential(cfg, "merge"), MISSING);
  const { UNRELATED_TWO_BOT_TEST: unrelated } = process.env;
  assert.equal(unrelated, undefined);
  fs.rmSync(cfg.credentialsEnvFile);
  assert.throws(() => credential(cfg, "dev"), MISSING);
  assert.throws(() => credential(cfg, "merge"), MISSING);
});

test("publicly readable credentials refuse selection", () => {
  const { cfg } = testConfig(credentialConfig("pipeline-bot"));
  fs.chmodSync(cfg.credentialsEnvFile, PUBLIC_FILE_MODE);
  assert.throws(() => credential(cfg, "dev"), MISSING);
});

test("each operation uses its explicit bot; swapped logins fail before writes", () => {
  const { cfg } = testConfig();
  fake.reply([
    { when: "pr ready 42", stdout: "" },
    { when: "api -X POST repos/example/repo/issues/7/comments", stdout: "" },
  ]);
  gh(cfg, "dev", ["pr", "ready", "42"]);
  gh(cfg, "merge", [
    "api",
    "-X",
    "POST",
    "repos/example/repo/issues/7/comments",
  ]);
  assert.equal(fake.calls().length, 2);
  const swapped = credentialConfig("someone-else");
  fake.reply([]);
  assert.throws(
    () =>
      gh({ ...cfg, credentialsEnvFile: swapped.credentialsEnvFile }, "merge", [
        "pr",
        "view",
        "42",
      ]),
    VERIFY,
  );
  assert.deepEqual(fake.calls(), []);
});

test("failures and allowFail results redact the selected fake token", () => {
  const { cfg } = testConfig();
  const args = ["pr", "view", "42"];
  fake.reply([
    {
      when: "pr view",
      stdout: MERGE,
      stderr: `refused ${MERGE}`,
      code: 1,
      keep: true,
    },
  ]);
  const result = gh(cfg, "merge", args, { allowFail: true });
  assert.equal(result.stdout, "<token>");
  assert.equal(result.stderr, "refused <token>");
  assert.throws(
    () => gh(cfg, "merge", args),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(MERGE), false);
      assert.equal(error.message.includes("<token>"), true);
      return true;
    },
  );
});

test("ordinary children strip fixed, ambient, legacy and Git debug/injection credentials", () => {
  const { cfg } = testConfig({
    jobRoles: { writer: { tokenEnv: "OLD_ROLE_TOKEN" } },
  });
  assert.ok(cfg.jobRoles?.writer);
  const names = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "ISSUE_PIPELINE_DEV_GITHUB_TOKEN",
    "ISSUE_PIPELINE_MERGE_GITHUB_TOKEN",
    "OLD_ROLE_TOKEN",
    "GH_DEBUG",
    "GIT_ASKPASS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_TRACE_CURL",
  ];
  const inherited = Object.fromEntries(
    names.map((name) => [name, "fake-inherited"]),
  );
  assert.deepEqual(
    childEnvironment({
      ...inherited,
      ...Object.fromEntries([["SAFE_VALUE", "kept"]]),
    }),
    Object.fromEntries([["SAFE_VALUE", "kept"]]),
  );
  Object.assign(process.env, inherited);
  try {
    const script = `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.filter(name => process.env[name] !== undefined)))`;
    assert.deepEqual(
      JSON.parse(run(process.execPath, ["-e", script]).stdout),
      [],
    );
  } finally {
    for (const name of names) {
      Reflect.deleteProperty(process.env, name);
    }
  }
});

test("bot allow-list entries never become humans; collaborator revocation is fresh", () => {
  const { cfg } = testConfig({
    allowedUsers: ["owner", "dev-bot", "pipeline-bot"],
  });
  fake.reply([]);
  assert.equal(isAllowedUser(cfg, "dev-bot"), false);
  assert.equal(isAllowedUser(cfg, "pipeline-bot"), false);
  assert.deepEqual(fake.calls(), []);
  fake.reply([
    { when: "collaborators/owner", stdout: "" },
    { when: "collaborators/owner", stderr: "not a collaborator", code: 1 },
  ]);
  assert.equal(isAllowedUser(cfg, "owner"), true);
  assert.equal(isAllowedUser(cfg, "owner"), false);
  assert.equal(fake.calls().length, 2);
});

test("missing merge credentials cannot fall back to development, ambient or role tokens before REST merge", () => {
  const { cfg } = testConfig(credentialConfig("pipeline-bot"));
  fs.writeFileSync(
    cfg.credentialsEnvFile,
    `ISSUE_PIPELINE_DEV_GITHUB_TOKEN=${DEV}\n`,
  );
  const ambient = Object.fromEntries([
    ["GH_TOKEN", DEV],
    ["ISSUE_PIPELINE_MERGE_GITHUB_TOKEN", MERGE],
  ]);
  Object.assign(process.env, ambient);
  fake.reply([]);
  try {
    assert.throws(
      () =>
        gh(cfg, "merge", [
          "api",
          "--method",
          "POST",
          "repos/example/repo/merges",
          "-f",
          "base=integration",
          "-f",
          "head=immutable-fake-head",
        ]),
      MISSING,
    );
    assert.deepEqual(fake.calls(), []);
  } finally {
    for (const name of Object.keys(ambient)) {
      Reflect.deleteProperty(process.env, name);
    }
  }
});

test("fake fine-grained token diagnostics and argv are redacted too", () => {
  const selected = "github_pat_fake_not_a_real_credential";
  const env = new Map([["GH_TOKEN", selected]]);
  const args = [
    "-e",
    "process.stderr.write(process.env.GH_TOKEN); process.exit(1)",
    selected,
  ];
  assert.throws(
    () => credentialedRun(process.execPath, args, { env }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(selected), false);
      assert.equal(error.message.includes("<token>"), true);
      return true;
    },
  );
  const { stderr, code } = credentialedRun(process.execPath, args, {
    env,
    allowFail: true,
  });
  assert.equal(code, 1);
  assert.equal(stderr, "<token>");
});

test("ordinary web/build-style shell commands do not inherit either loaded or ambient pipeline token", () => {
  const { cfg } = testConfig(credentialConfig("pipeline-bot"));
  const dir = path.join(isolatedRoot, "web-build");
  fs.mkdirSync(dir);
  assert.equal(credential(cfg, "dev"), DEV);
  assert.equal(credential(cfg, "merge"), MERGE);
  const names = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ISSUE_PIPELINE_DEV_GITHUB_TOKEN",
    "ISSUE_PIPELINE_MERGE_GITHUB_TOKEN",
  ];
  fs.writeFileSync(
    path.join(dir, "build-env.mjs"),
    `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.filter(name => process.env[name] !== undefined)))`,
  );
  Object.assign(
    process.env,
    Object.fromEntries(names.map((name) => [name, "fake-inherited"])),
  );
  try {
    const result = shell(
      "node build-env.mjs",
      dir,
      undefined,
      COMMAND_TIMEOUT_MS,
    );
    assert.equal(result.code, 0);
    assert.equal(result.tail, "[]");
  } finally {
    for (const name of names) {
      Reflect.deleteProperty(process.env, name);
    }
  }
});
