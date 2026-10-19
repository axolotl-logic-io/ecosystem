// @ts-check
// install.mjs into temporary roots: every file lands, the executables are
// the ones it built into dist/, every stage's agent is installed with its
// placeholders filled, a second install
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
// The agents the stage jobs' sessions run as (src/job/roles.ts).
const STAGE_AGENT_FILES = [
  "issue-pipeline-author.md",
  "issue-pipeline-implementor.md",
  "issue-pipeline-reviewer.md",
];
// What a template still holds when a placeholder is left unfilled.
const PLACEHOLDER = /\{\{/u;
const NOTHING_CHANGED = /0 pipeline file\(s\) changed/u;
const INSIDE_ROOT = /inside the pipeline root/u;
// The build's files, each installed under its own name in the root.
const BUILT = [
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
  ["HOME", tmp],
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

const RETAINED = [
  "runtime/home/.pi/agent/settings.json",
  "runtime/home/.pi/agent/pi-cliproxyapi/config.json",
  "runtime/home/.pi/agent/pi-cliproxyapi/discovery-cache.json",
  "work/retained/commits.bundle",
  "runs/o__r/issue-7/sessions/original.jsonl",
  "runs/o__r/issue-7/recovery/index.patch",
  "runs/o__r/issue-7/authority.json",
];

/** @returns {void} */
function seedOperatorState() {
  for (const file of RETAINED) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `operator-owned ${file}\n`);
  }
}

test("dry run writes nothing", () => {
  const r = install("--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(path.join(tmp, "agent")), false);
});

test("installs the pipeline with local paths filled in", () => {
  fs.mkdirSync(path.join(root, "repos"), { recursive: true });
  fs.writeFileSync(path.join(root, "repos/local.json"), "{}");
  seedOperatorState();
  fs.rmSync(dist, { recursive: true, force: true });
  const r = install();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    fs.existsSync(path.join(dist, "job.mjs")),
    "the install rebuilt dist/",
  );
  for (const f of [
    ...BUILT,
    "repos/example.json",
    "runtime/pi-cliproxyapi-config.example.json",
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
  assert.equal(fs.existsSync(path.join(root, "workflow.js")), false);
  for (const file of RETAINED) {
    assert.equal(
      fs.readFileSync(path.join(root, file), "utf8"),
      `operator-owned ${file}\n`,
    );
  }
  for (const f of STAGE_AGENT_FILES) {
    const agent = fs.readFileSync(
      path.join(tmp, "agent/agents/issue-pipeline", f),
      "utf8",
    );
    assert.doesNotMatch(agent, PLACEHOLDER, f);
  }
  assert.equal(
    fs.readFileSync(path.join(root, "repos/local.json"), "utf8"),
    "{}",
  );
});

test("installed identity records the candidate commit", () => {
  const identity = JSON.parse(
    fs.readFileSync(path.join(root, "INSTALLED.json"), "utf8"),
  );
  const head = spawnSync(
    "git",
    ["-C", path.dirname(script), "rev-parse", "HEAD"],
    { encoding: "utf8" },
  );
  assert.equal(head.status, 0);
  assert.equal(identity.commit, head.stdout.trim());
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

test("a fresh installation provisions no runnable runtime", () => {
  const fresh = path.join(tmp, "fresh-root");
  const result = spawnSync(process.execPath, [script, "--allow-dirty"], {
    env: { ...env, ...Object.fromEntries([["ISSUE_PIPELINE_ROOT", fresh]]) },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(fresh, "runtime")), [
    "pi-cliproxyapi-config.example.json",
  ]);
  assert.equal(fs.existsSync(path.join(fresh, "secrets")), false);
});
