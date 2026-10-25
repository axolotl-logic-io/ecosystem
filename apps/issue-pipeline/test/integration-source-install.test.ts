// install.ts retires the files an older install left
// in temporary roots: a dry run lists them and touches nothing, an install
// backs each one up and removes it, and it leaves pi's other files and the
// current agents in place.
import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

const script: string = new URL("../install.ts", import.meta.url).pathname;
const tmp = fs.mkdtempSync("/tmp/issue-pipeline-retire-");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const home = path.join(tmp, "home");
const agentDir = path.join(tmp, "agent");
const root = path.join(agentDir, "issue-pipeline");
if (!root.startsWith("/tmp/issue-pipeline-retire-")) {
  throw new Error(`refusing to install outside a temporary root: ${root}`);
}
const env = Object.fromEntries([
  ...Object.entries(process.env),
  ["HOME", home],
  ["ISSUE_PIPELINE_ROOT", root],
  ["PI_CODING_AGENT_DIR", agentDir],
]);
const RETIRED: string[] = [
  path.join(root, "workflow.js"),
  ...["escalation", "ops", "reader", "specifier", "writer"].map((agent) =>
    path.join(agentDir, `agents/issue-pipeline/issue-pipeline-${agent}.md`),
  ),
  path.join(agentDir, "prompts/pipeline-start.md"),
  path.join(agentDir, "prompts/pipeline-pause.md"),
];
// Files pi keeps beside the retired ones, which the install never touches.
const KEPT = [
  path.join(agentDir, "prompts/my-own.md"),
  path.join(agentDir, "agents/someone-else.md"),
  path.join(root, "repos/local.json"),
];
const AUTHOR_AGENT = path.join(
  agentDir,
  "agents/issue-pipeline/issue-pipeline-author.md",
);
const DRY_RUN_SUMMARY = /dry run: \d+ pipeline file\(s\) would change/u;
const BACKUP_FOLDER = /^\d{8}-\d{6}-install$/u;

function oldText(file: string): string {
  return `old ${path.basename(file)}\n`;
}

function install(...flags: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script, "--allow-dirty", ...flags], {
    env,
    encoding: "utf8",
  });
}

for (const file of [...RETIRED, ...KEPT]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, oldText(file));
}

test("a dry run lists each retired file and removes nothing", () => {
  const r = install("--dry-run");
  assert.equal(r.status, 0, r.stderr);
  for (const file of RETIRED) {
    assert.ok(r.stdout.includes(`retired  ${file}`), `${file}\n${r.stdout}`);
    assert.equal(fs.readFileSync(file, "utf8"), oldText(file));
  }
  assert.match(r.stdout, DRY_RUN_SUMMARY);
  assert.equal(fs.existsSync(`${root}-backups`), false);
  assert.equal(fs.existsSync(AUTHOR_AGENT), false);
});

test("an install backs up and removes each retired file and keeps the rest", () => {
  const r = install();
  assert.equal(r.status, 0, r.stderr);
  const [stamp, ...more] = fs.readdirSync(`${root}-backups`);
  assert.deepEqual(more, []);
  assert.match(String(stamp), BACKUP_FOLDER);
  const backup = path.join(`${root}-backups`, String(stamp));
  for (const file of RETIRED) {
    assert.equal(fs.existsSync(file), false, file);
    const copy = path.join(backup, path.relative("/", file));
    assert.equal(fs.readFileSync(copy, "utf8"), oldText(file), copy);
  }
  for (const file of KEPT) {
    assert.equal(fs.readFileSync(file, "utf8"), oldText(file), file);
  }
  assert.ok(fs.existsSync(AUTHOR_AGENT));
  assert.ok(fs.existsSync(path.join(root, "job.mjs")));
});

test("a later install has nothing to retire", () => {
  const r = install("--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes("retired "), false, r.stdout);
});
