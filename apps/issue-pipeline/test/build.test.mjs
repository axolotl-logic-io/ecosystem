// @ts-check
// build.ts into a temporary folder: it builds every executable the install
// copies and no workflow, the built ops CLI answers as src/ops.ts does and
// its shell supervisor parses, the built stage job rejects a bad stage, the
// built orchestrator's --once exits 0 after a tick and 1 after one that
// throws, the built report names a missing --config, and the built caller's
// launcher reports an empty run and names its commands, and the built
// standards upgrade loads and names its commands. It builds into its
// own folder, so it never races install.test.mjs, which builds dist/.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { credentialConfig } from "./credentials-test-kit.mjs";
import { installFakeGh } from "./fake-gh.mjs";

// The executables the build writes, which install.mjs copies.
const EXECUTABLES = [
  "ops.mjs",
  "shell-supervisor.mjs",
  "job.mjs",
  "orchestrate.mjs",
  "report.mjs",
  "structured-output.mjs",
  "pipeline-commit.mjs",
  "git-review.mjs",
  "caller-jobs.mjs",
  "sweep.mjs",
  "standards-upgrade.mjs",
];
// The error the stage job exits with for an unknown --stage.
const BAD_STAGE = /--stage must be one of/u;
const UNKNOWN_FLAG = /--nope/u;
const NO_CONFIG = /--config must name a repo config file/u;
const NO_COMMAND = /give start, status or wait/u;
const UPGRADE_USAGE = /^usage: standards-upgrade assess/u;
// What the orchestrator prints when a tick throws, here because gh is logged
// in as another account than the config's.
const TICK_FAILED = /tick failed/iu;
const WRONG_ACCOUNT = /mallory|wrong account/iu;
// The account the orchestrator's test config names.
const ACCOUNT = "bot";
// The variable that points ops at a pipeline root, here the temporary folder.
const ROOT_VAR = "ISSUE_PIPELINE_ROOT";

// Runs an ops CLI on `input` with only the pipeline root in its environment,
// so the source and the built CLI see the same environment.
/**
 * @param {string} file
 * @param {string} input
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runOps(file, input) {
  return spawnSync(process.execPath, [file], {
    input,
    encoding: "utf8",
    env: { [ROOT_VAR]: tmp },
  });
}

const script = new URL("../build.ts", import.meta.url).pathname;
const srcOps = new URL("../src/ops.ts", import.meta.url).pathname;
const tmp = fs.mkdtempSync("/tmp/issue-pipeline-build-");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const built = spawnSync(process.execPath, [script, tmp], { encoding: "utf8" });
const builtOps = path.join(tmp, "ops.mjs");

test("the build writes every executable and no workflow", () => {
  assert.equal(built.status, 0, built.stderr);
  for (const file of EXECUTABLES) {
    assert.ok(fs.existsSync(path.join(tmp, file)), file);
  }
  assert.equal(fs.existsSync(path.join(tmp, "workflow.js")), false);
});

test("every built executable parses and ops keeps its #! line", () => {
  for (const file of EXECUTABLES) {
    const parsed = spawnSync(
      process.execPath,
      ["--check", path.join(tmp, file)],
      { encoding: "utf8" },
    );
    assert.equal(parsed.status, 0, `${file}: ${parsed.stderr}`);
  }
  assert.ok(
    fs.readFileSync(builtOps, "utf8").startsWith("#!/usr/bin/env node\n"),
  );
});

// Inputs the ops CLI answers without running an op, by name.
/** @type {[name: string, input: string][]} */
const ANSWERED_INPUTS = [
  ["no request", "nothing"],
  ["an unknown op", 'BEGIN_OPS_REQUEST {"op":"nope"} END_OPS_REQUEST'],
];

for (const [name, input] of ANSWERED_INPUTS) {
  test(`the built ops answers ${name} as src/ops.ts does`, () => {
    const want = runOps(srcOps, input);
    const got = runOps(builtOps, input);
    assert.equal(want.status, 0, want.stderr);
    assert.equal(got.status, 0, got.stderr);
    assert.equal(got.stdout, want.stdout);
  });
}

test("the built stage job parses, keeps its #! line and rejects a bad stage", () => {
  const job = path.join(tmp, "job.mjs");
  assert.ok(fs.readFileSync(job, "utf8").startsWith("#!/usr/bin/env node\n"));
  const r = spawnSync(
    process.execPath,
    [job, "--config", "/none.json", "--issue", "7", "--stage", "nope"],
    { encoding: "utf8", env: { [ROOT_VAR]: tmp } },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, BAD_STAGE);
});

test("the built orchestrator parses and names a bad flag or a missing --config", () => {
  const orchestrator = path.join(tmp, "orchestrate.mjs");
  const head = fs.readFileSync(orchestrator, "utf8");
  assert.ok(head.startsWith("#!/usr/bin/env node\n"));
  /** @param {string[]} args @returns {import("node:child_process").SpawnSyncReturns<string>} */
  function run(args) {
    return spawnSync(process.execPath, [orchestrator, ...args], {
      encoding: "utf8",
      env: { [ROOT_VAR]: tmp },
    });
  }
  const unknown = run(["--config", "/none.json", "--nope"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, UNKNOWN_FLAG);
  const missing = run(["--once"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, NO_CONFIG);
});

test("the built report parses, keeps its #! line and names a missing --config", () => {
  const report = path.join(tmp, "report.mjs");
  const head = fs.readFileSync(report, "utf8");
  assert.ok(head.startsWith("#!/usr/bin/env node\n"));
  const missing = spawnSync(process.execPath, [report, "usage"], {
    encoding: "utf8",
    env: Object.fromEntries([[ROOT_VAR, tmp]]),
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, NO_CONFIG);
});

test("the built standards upgrade loads its modules and names its commands", () => {
  const upgrade = path.join(tmp, "standards-upgrade.mjs");
  const run = spawnSync(process.execPath, [upgrade], {
    encoding: "utf8",
    env: Object.fromEntries([[ROOT_VAR, tmp]]),
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, UPGRADE_USAGE);
});

test("the built caller's launcher keeps its #! line, reports an empty run and names its commands", () => {
  const launcher = path.join(tmp, "caller-jobs.mjs");
  assert.ok(
    fs.readFileSync(launcher, "utf8").startsWith("#!/usr/bin/env node\n"),
  );
  /** @param {string[]} args @returns {import("node:child_process").SpawnSyncReturns<string>} */
  function run(args) {
    return spawnSync(process.execPath, [launcher, ...args], {
      encoding: "utf8",
      env: { [ROOT_VAR]: tmp },
    });
  }
  const runDir = fs.mkdtempSync(path.join(tmp, "run-"));
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify({ maxJobs: 1, maxAttempts: 1 }),
  );
  const status = run(["status", "--run", runDir]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, "");
  const none = run([]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, NO_COMMAND);
});

// A repo config for the built orchestrator, cloning a bare origin in tmp.
/** @returns {string} */
function orchestratorConfig() {
  const origin = path.join(tmp, "origin.git");
  const seed = spawnSync(
    "bash",
    [
      "-c",
      `git init -q --bare -b integration ${origin} && git clone -q ${origin} ${tmp}/seed 2>/dev/null; cd ${tmp}/seed && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m base && git push -q origin HEAD:integration`,
    ],
    { encoding: "utf8" },
  );
  if (seed.status !== 0) {
    throw new Error(`could not seed the origin: ${seed.stderr}`);
  }
  const file = path.join(tmp, "repo.json");
  const config = {
    repo: "o/r",
    ...credentialConfig(ACCOUNT),
    allowedUsers: ["alice"],
    cloneUrl: origin,
    baseBranch: "integration",
    commands: { test: "true" },
  };
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

test("the built orchestrator's --once exits 0 after a tick and 1 after a failed one", () => {
  const fakeGh = installFakeGh();
  const config = orchestratorConfig();
  const orchestrator = path.join(tmp, "orchestrate.mjs");
  /** @returns {import("node:child_process").SpawnSyncReturns<string>} */
  function once() {
    return spawnSync(
      process.execPath,
      [orchestrator, "--config", config, "--once"],
      {
        encoding: "utf8",
        env: { ...process.env, [ROOT_VAR]: tmp },
      },
    );
  }
  fakeGh.reply([
    { when: "api user", stdout: `${ACCOUNT}\n` },
    { when: "label list", stdout: "[]" },
    { when: "issue list", stdout: "[]" },
  ]);
  const good = once();
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stderr, "");
  assert.ok(
    fakeGh.calls().some((call) => call.join(" ").startsWith("issue list")),
  );
  const parsed = JSON.parse(fs.readFileSync(config, "utf8"));
  parsed.credentialsEnvFile = credentialConfig("mallory").credentialsEnvFile;
  fs.writeFileSync(config, JSON.stringify(parsed));
  fakeGh.reply([]);
  const failed = once();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, TICK_FAILED);
  assert.match(failed.stderr, WRONG_ACCOUNT);
});

test("the built pi extensions default-export their factories", async () => {
  const files = ["structured-output.mjs", "pipeline-commit.mjs"];
  const extensions = await Promise.all(
    files.map((file) => import(path.join(tmp, file))),
  );
  for (const extension of extensions) {
    assert.equal(typeof extension.default, "function");
  }
});
