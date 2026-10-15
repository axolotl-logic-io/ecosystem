// build.ts into a temporary folder: the built workflow is still an async
// function body with no imports, and the built ops CLI answers as src/ops.ts
// does. It builds into its own folder, so it never races install.test.mjs,
// which builds dist/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

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
// The error the stage job exits with for an unknown --stage.
const BAD_STAGE = /--stage must be one of/u;
// The variable that points ops at a pipeline root, here the temporary folder.
const ROOT_VAR = "ISSUE_PIPELINE_ROOT";

function readIfExists(file) {
  if (!fs.existsSync(file)) {
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

// Runs an ops CLI on `input` with only the pipeline root in its environment,
// so the source and the built CLI see the same environment.
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

for (const [name, input] of [
  ["no request", "nothing"],
  ["an unknown op", 'BEGIN_OPS_REQUEST {"op":"nope"} END_OPS_REQUEST'],
]) {
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

test("the built pi extension default-exports its factory", async () => {
  const extension = await import(path.join(tmp, "structured-output.mjs"));
  assert.equal(typeof extension.default, "function");
});
