// @ts-check
// install.mjs into temporary roots: every file lands, the workflow and ops are
// the ones it built into dist/, placeholders are filled, a second install
// replaces nothing and backs nothing up, and a failed build installs nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

const script = new URL("../install.mjs", import.meta.url).pathname;
const dist = new URL("../dist/", import.meta.url).pathname;
const BUILD_FAILED = /build failed/u;
// What a template still holds when a placeholder is left unfilled.
const PLACEHOLDER = /\{\{/u;
const NOTHING_CHANGED = /0 pipeline file\(s\) changed/u;
const INSIDE_ROOT = /inside the pipeline root/u;
// The build's files, each installed under its own name in the root.
const BUILT = [
  "workflow.js",
  "ops.mjs",
  "shell-supervisor.mjs",
  "job.mjs",
  "structured-output.mjs",
  "pipeline-commit.mjs",
  "orchestrate.mjs",
  "report.mjs",
];
const tmp = fs.mkdtempSync("/tmp/issue-pipeline-install-");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const root = path.join(tmp, "agent/issue-pipeline");
// Environment variables are named by strings, as src/process.ts takes them.
const env = Object.fromEntries([
  ...Object.entries(process.env),
  ["ISSUE_PIPELINE_ROOT", root],
  ["PI_CODING_AGENT_DIR", path.join(tmp, "agent")],
]);

// Runs the install script `file` from its checkout with `flags`.
/**
 * @param {string} file
 * @param {...string} flags
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function installFrom(file, ...flags) {
  return spawnSync(process.execPath, [file, "--allow-dirty", ...flags], {
    env,
    encoding: "utf8",
  });
}
// Runs this checkout's install.mjs with `flags`.
/** @param {...string} flags @returns {import("node:child_process").SpawnSyncReturns<string>} */
function install(...flags) {
  return installFrom(script, ...flags);
}

test("dry run writes nothing", () => {
  const r = install("--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(root), false);
});

test("installs the pipeline with local paths filled in", () => {
  fs.mkdirSync(path.join(root, "repos"), { recursive: true });
  fs.writeFileSync(path.join(root, "repos/local.json"), "{}");
  fs.rmSync(dist, { recursive: true, force: true });
  const r = install();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    fs.existsSync(path.join(dist, "workflow.js")),
    "the install rebuilt dist/",
  );
  for (const f of [
    ...BUILT,
    "repos/example.json",
    "README.md",
    "INSTALLED.json",
  ]) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
  for (const f of BUILT) {
    assert.equal(
      fs.readFileSync(path.join(root, f), "utf8"),
      fs.readFileSync(path.join(dist, f), "utf8"),
      f,
    );
  }
  const ops = fs.readFileSync(
    path.join(tmp, "agent/agents/issue-pipeline/issue-pipeline-ops.md"),
    "utf8",
  );
  assert.match(ops, new RegExp(`"${root}/ops.mjs"`, "u"));
  const start = fs.readFileSync(
    path.join(tmp, "agent/prompts/pipeline-start.md"),
    "utf8",
  );
  assert.doesNotMatch(start, PLACEHOLDER);
  assert.equal(
    fs.readFileSync(path.join(root, "repos/local.json"), "utf8"),
    "{}",
  );
});

test("a second install changes nothing", () => {
  const r = install();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, NOTHING_CHANGED);
  assert.equal(fs.existsSync(`${root}-backups`), false);
});

test("refuses to install from inside the pipeline root", () => {
  const inside = path.join(root, "work/x");
  fs.mkdirSync(inside, { recursive: true });
  fs.copyFileSync(script, path.join(inside, "install.mjs"));
  const r = spawnSync(process.execPath, [path.join(inside, "install.mjs")], {
    env,
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, INSIDE_ROOT);
});

test("installs nothing when the build fails", () => {
  const checkout = path.join(tmp, "checkout");
  fs.mkdirSync(checkout);
  fs.copyFileSync(script, path.join(checkout, "install.mjs"));
  fs.writeFileSync(
    path.join(checkout, "build.ts"),
    'console.error("stub build error");\nprocess.exit(1);\n',
  );
  const name = ["-c", "user.name=test", "-c", "user.email=test@example.com"];
  const commit = [...name, "commit", "--quiet", "--allow-empty", "-m", "x"];
  for (const args of [["init", "--quiet"], commit]) {
    const git = spawnSync("git", ["-C", checkout, ...args]);
    assert.equal(git.status, 0, args.join(" "));
  }
  const installed = path.join(root, "INSTALLED.json");
  const before = fs.readFileSync(installed, "utf8");
  const r = installFrom(path.join(checkout, "install.mjs"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, BUILD_FAILED);
  assert.equal(fs.readFileSync(installed, "utf8"), before);
});
