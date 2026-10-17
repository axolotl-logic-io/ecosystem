// @ts-check
// build.ts into a temporary folder: the built workflow is still an async
// function body with no imports, and the built ops CLI answers as src/ops.ts
// does, the built orchestrator's --once exits 0 after a tick and 1 after
// one that throws, and the built report names a missing --config. It builds into its own folder, so it never races install.test.mjs,
// which builds dist/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { installFakeGh } from "./fake-gh.mjs";

// What the built workflow must never contain: it is a sandboxed function body.
const BANNED_IN_WORKFLOW = [
  /\basync\b/u,
  /\bimport\b/u,
  /\brequire\(/u,
  /node:/u,
  /child_process/u,
];
// The error the workflow throws when it is run without args.config.
const MISSING_CONFIG = /args\.config must be/u;
// The statement build.ts's wrapper adds as the body's last.
const RETURN_SUMMARY = "return sweep.summary();";
// The error the stage job exits with for an unknown --stage.
const BAD_STAGE = /--stage must be one of/u;
const UNKNOWN_FLAG = /--nope/u;
const NO_CONFIG = /--config must name a repo config file/u;
// What the orchestrator prints when a tick throws, here because gh is logged
// in as another account than the config's.
const TICK_FAILED = /orchestrate: tick failed: gh is logged in as mallory/u;
// The account the orchestrator's test config names.
const ACCOUNT = "bot";
// The variable that points ops at a pipeline root, here the temporary folder.
const ROOT_VAR = "ISSUE_PIPELINE_ROOT";

/** @param {string} file @returns {string} */
function readIfExists(file) {
  if (!fs.existsSync(file)) {
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

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
const workflow = readIfExists(path.join(tmp, "workflow.js"));
const builtOps = path.join(tmp, "ops.mjs");
const AsyncFunction = Object.getPrototypeOf(async () => null).constructor;

test("the build succeeds and the workflow compiles as an async function body", () => {
  assert.equal(built.status, 0, built.stderr);
  assert.doesNotThrow(() => new AsyncFunction("args", workflow));
});

test("the built workflow stays a sandboxed body with no imports", () => {
  for (const banned of BANNED_IN_WORKFLOW) {
    assert.doesNotMatch(workflow, banned);
  }
});

test("the built workflow ends by returning the driver's summary", () => {
  assert.ok(workflow.trimEnd().endsWith(RETURN_SUMMARY));
});

test("the built workflow rejects a missing config as the source does", async () => {
  await assert.rejects(new AsyncFunction("args", workflow)({}), MISSING_CONFIG);
});

test("the built ops parses and keeps its #! line", () => {
  const r = spawnSync(process.execPath, ["--check", builtOps], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
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
  const check = spawnSync(process.execPath, ["--check", job], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
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
  const check = spawnSync(process.execPath, ["--check", orchestrator], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
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
  const check = spawnSync(process.execPath, ["--check", report], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
  const head = fs.readFileSync(report, "utf8");
  assert.ok(head.startsWith("#!/usr/bin/env node\n"));
  const missing = spawnSync(process.execPath, [report, "usage"], {
    encoding: "utf8",
    env: Object.fromEntries([[ROOT_VAR, tmp]]),
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, NO_CONFIG);
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
    account: ACCOUNT,
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
  const log = path.join(tmp, "runs", "o__r", "orchestrator.log");
  assert.equal(readIfExists(log), "");
  fakeGh.reply([{ when: "api user", stdout: "mallory\n" }]);
  const failed = once();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, TICK_FAILED);
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
