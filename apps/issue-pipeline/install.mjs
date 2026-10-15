#!/usr/bin/env node
// Installs the issue pipeline from this folder into the places pi reads it:
//
//   workflow.js, ops.mjs, repos/example.json  -> $ISSUE_PIPELINE_ROOT (default ~/.pi/agent/issue-pipeline)
//   agents/*.md                               -> $PI_CODING_AGENT_DIR/agents/issue-pipeline/ (default ~/.pi/agent)
//   prompts/*.md                              -> $PI_CODING_AGENT_DIR/prompts/
//
// In agents and prompts, {{ISSUE_PIPELINE_ROOT}} and {{PI_CODING_AGENT_DIR}}
// become those absolute paths. It writes README.md and INSTALLED.json in the
// root, naming the commit installed. Per-repo configs, setup and teardown
// scripts, secrets, clones, worktrees and run logs are left alone.
//
// The running pipeline changes only here, never when a PR merges, so an agent's
// PR can't change the code that checks its own work. Every file it replaces is
// copied first to <root>-backups/<timestamp>-install/.
//
// Usage: node install.mjs [--dry-run] [--allow-dirty]
//   --dry-run      list what would change and write nothing
//   --allow-dirty  install even with uncommitted changes in this folder

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const ROOT = path.resolve(process.env.ISSUE_PIPELINE_ROOT || path.join(HOME, ".pi/agent/issue-pipeline"));
const AGENT_DIR = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(HOME, ".pi/agent"));
const dryRun = process.argv.includes("--dry-run");
const allowDirty = process.argv.includes("--allow-dirty");

function fail(message) {
  console.error(`install: ${message}`);
  process.exit(1);
}

function git(...args) {
  const r = spawnSync("git", ["-C", SRC, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The pipeline's own worktrees live under the root, and agents work in them.
const real = (p) => (fs.existsSync(p) ? fs.realpathSync(p) : p);
if (real(SRC) === real(ROOT) || real(SRC).startsWith(real(ROOT) + path.sep)) {
  fail(`refusing to install from ${SRC}, inside the pipeline root; install from a checkout of your own`);
}
const commit = git("rev-parse", "HEAD");
if (!commit) fail(`${SRC} is not in a git checkout`);
const dirty = git("status", "--porcelain", "--", ".");
if (dirty && !allowDirty) fail(`uncommitted changes in ${SRC}:\n${dirty}\nCommit them, or pass --allow-dirty`);
const repo = (git("remote", "get-url", "origin") || "").replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");

const fill = (text) => text.replaceAll("{{ISSUE_PIPELINE_ROOT}}", ROOT).replaceAll("{{PI_CODING_AGENT_DIR}}", AGENT_DIR);
const mdIn = (dir) => fs.readdirSync(path.join(SRC, dir)).filter((f) => f.endsWith(".md")).sort();

const files = [
  { from: "workflow.js", to: path.join(ROOT, "workflow.js") },
  { from: "ops.mjs", to: path.join(ROOT, "ops.mjs") },
  { from: "repos/example.json", to: path.join(ROOT, "repos/example.json") },
  ...mdIn("agents").map((f) => ({ from: `agents/${f}`, to: path.join(AGENT_DIR, "agents/issue-pipeline", f), fill: true })),
  ...mdIn("prompts").map((f) => ({ from: `prompts/${f}`, to: path.join(AGENT_DIR, "prompts", f), fill: true })),
].map((f) => {
  const text = fs.readFileSync(path.join(SRC, f.from), "utf8");
  return { ...f, text: f.fill ? fill(text) : text };
});
for (const f of files) {
  if (f.text.includes("{{")) fail(`${f.from} has a placeholder this script doesn't know`);
}

const at = new Date().toISOString();
const shortSha = commit.slice(0, 7) + (dirty ? " (with uncommitted changes)" : "");
files.push(
  {
    from: "(generated)",
    to: path.join(ROOT, "README.md"),
    text: `# Issue pipeline (installed copy)

Installed from \`apps/issue-pipeline/\` of ${repo || "the pipeline's repo"} at ${shortSha}, ${at}.

Don't edit the code here: change it in the repo and run \`mise //apps/issue-pipeline:install\`, which overwrites these files. The per-repo configs in \`repos/\` (except \`example.json\`), their setup and teardown scripts, \`secrets/\`, \`clones/\`, \`work/\` and \`runs/\` are local and never installed.

See \`apps/issue-pipeline/README.md\` in the repo for how it works.
`,
  },
  {
    from: "(generated)",
    to: path.join(ROOT, "INSTALLED.json"),
    text: `${JSON.stringify({ repo, commit, dirty: !!dirty, at, source: SRC.replace(HOME, "~") }, null, 2)}\n`,
  },
);

const backup = path.join(`${ROOT}-backups`, `${at.replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-install`);
let changed = 0;
for (const f of files) {
  const old = fs.existsSync(f.to) ? fs.readFileSync(f.to, "utf8") : null;
  const status = old === null ? "new" : old === f.text ? "same" : "updated";
  const generated = f.from === "(generated)";
  if (status !== "same" && !generated) changed++;
  console.log(`${status.padEnd(8)} ${f.to.replace(HOME, "~")}`);
  if (dryRun || status === "same") continue;
  if (old !== null && !generated) {
    const copy = path.join(backup, path.relative(path.parse(f.to).root, f.to));
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, old);
  }
  fs.mkdirSync(path.dirname(f.to), { recursive: true });
  fs.writeFileSync(f.to, f.text);
}
console.log(
  dryRun
    ? `dry run: ${changed} pipeline file(s) would change; nothing written`
    : `installed ${shortSha}: ${changed} pipeline file(s) changed${changed ? `; replaced files are in ${backup.replace(HOME, "~")}` : ""}`,
);
