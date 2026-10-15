// install.mjs into temporary roots: every file lands, placeholders are filled,
// and a second install replaces nothing and backs nothing up.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const script = new URL("../install.mjs", import.meta.url).pathname;
const tmp = fs.mkdtempSync("/tmp/issue-pipeline-install-");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const root = path.join(tmp, "agent/issue-pipeline");
const env = { ...process.env, ISSUE_PIPELINE_ROOT: root, PI_CODING_AGENT_DIR: path.join(tmp, "agent") };
const install = (...flags) => spawnSync(process.execPath, [script, "--allow-dirty", ...flags], { env, encoding: "utf8" });

test("dry run writes nothing", () => {
  const r = install("--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(root), false);
});

test("installs the pipeline with local paths filled in", () => {
  fs.mkdirSync(path.join(root, "repos"), { recursive: true });
  fs.writeFileSync(path.join(root, "repos/local.json"), "{}");
  const r = install();
  assert.equal(r.status, 0, r.stderr);
  for (const f of ["workflow.js", "ops.mjs", "repos/example.json", "README.md", "INSTALLED.json"]) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
  const ops = fs.readFileSync(path.join(tmp, "agent/agents/issue-pipeline/issue-pipeline-ops.md"), "utf8");
  assert.match(ops, new RegExp(`"${root}/ops.mjs"`));
  const start = fs.readFileSync(path.join(tmp, "agent/prompts/pipeline-start.md"), "utf8");
  assert.doesNotMatch(start, /\{\{/);
  assert.equal(fs.readFileSync(path.join(root, "repos/local.json"), "utf8"), "{}");
});

test("a second install changes nothing", () => {
  const r = install();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 pipeline file\(s\) changed/);
  assert.equal(fs.existsSync(`${root}-backups`), false);
});

test("refuses to install from inside the pipeline root", () => {
  const inside = path.join(root, "work/x");
  fs.mkdirSync(inside, { recursive: true });
  fs.copyFileSync(script, path.join(inside, "install.mjs"));
  const r = spawnSync(process.execPath, [path.join(inside, "install.mjs")], { env, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inside the pipeline root/);
});
