#!/usr/bin/env node
// @ts-check
// Builds src/ into dist/ (build.ts; run `npm ci` at the repo root first) and
// installs dist/*.mjs (BUILT) and repos/example.json in $ISSUE_PIPELINE_ROOT
// and agents/*.md, placeholders filled, in $PI_CODING_AGENT_DIR's
// agents/issue-pipeline/ (README.md). It names the commit in the root's
// README.md and INSTALLED.json and retires the files an older install left
// (retired()), leaving local configs, secrets and work alone. The running
// pipeline changes only here, never when a PR merges, so an agent's PR can't
// change the code that checks its own work. Every file it replaces or retires
// is copied first to <root>-backups/<timestamp>-install/.
//
// Usage: node install.mjs [--dry-run] [--allow-dirty]
//   --dry-run      list what would change and write nothing
//   --allow-dirty  install even with uncommitted changes in this folder

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// A file to install from a path here, GENERATED or RETIRED (text null: it is
// removed); a Source is one this folder holds, `fill` to fill in.
/** @typedef {{ from: string, to: string, text: string | null }} InstallFile */
/** @typedef {{ from: string, to: string, fill: boolean }} Source */
/** @typedef {"new" | "same" | "updated" | "retired"} Status */

const GENERATED = "(generated)";
const RETIRED = "(retired)";
const SHORT_SHA_LENGTH = 7;
// The backup folder's stamp: yyyymmdd-hhmmss.
const BACKUP_STAMP_LENGTH = 15;
const JSON_INDENT = 2;
const STATUS_WIDTH = 8;
const GITHUB_PREFIX = /^.*github\.com[:/]/u;
const GIT_SUFFIX = /\.git$/u;
const DATE_PUNCTUATION = /[-:]/gu;
// The build's files in dist/, each installed under its own name in ROOT.
const BUILT = [
  "ops.mjs",
  "shell-supervisor.mjs",
  "job.mjs",
  "orchestrate.mjs",
  "report.mjs",
  "structured-output.mjs",
  "pipeline-commit.mjs",
  "git-review.mjs",
];
// The agents of the stages an older install had, which retired() retires
// with its old workflow.js, which an old lane schedule could still run, and
// its old pi prompts.
const RETIRED_AGENTS = ["escalation", "ops", "reader", "specifier", "writer"];

const SRC = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const {
  ISSUE_PIPELINE_ROOT: rootVariable,
  PI_CODING_AGENT_DIR: agentDirVariable,
} = process.env;
const ROOT = path.resolve(
  rootVariable || path.join(HOME, ".pi/agent/issue-pipeline"),
);
const AGENT_DIR = path.resolve(
  agentDirVariable || path.join(HOME, ".pi/agent"),
);
const dryRun = process.argv.includes("--dry-run");
const allowDirty = process.argv.includes("--allow-dirty");

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`install: ${message}`);
  process.exit(1);
}

/** @param {string[]} args @returns {string | null} */
function git(...args) {
  const r = spawnSync("git", ["-C", SRC, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    return null;
  }
  return r.stdout.trim();
}

/** @param {string} p @returns {string} */
function real(p) {
  if (!fs.existsSync(p)) {
    return p;
  }
  return fs.realpathSync(p);
}

/** @param {string} text @returns {string} */
function fill(text) {
  return text
    .replaceAll("{{ISSUE_PIPELINE_ROOT}}", ROOT)
    .replaceAll("{{PI_CODING_AGENT_DIR}}", AGENT_DIR);
}

/** @param {string} dir @returns {string[]} */
function mdIn(dir) {
  return fs
    .readdirSync(path.join(SRC, dir))
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/** @returns {Source[]} */
function sources() {
  return [
    ...BUILT.map((f) => ({
      from: `dist/${f}`,
      to: path.join(ROOT, f),
      fill: false,
    })),
    ...["repos/example.json", "runtime/pi-cliproxyapi-config.example.json"].map(
      (from) => ({ from, to: path.join(ROOT, from), fill: false }),
    ),
    ...mdIn("agents").map((f) => ({
      from: `agents/${f}`,
      to: path.join(AGENT_DIR, "agents/issue-pipeline", f),
      fill: true,
    })),
  ];
}

/** @param {Source} source @returns {InstallFile} */
function read({ from, to, fill: filled }) {
  const text = fs.readFileSync(path.join(SRC, from), "utf8");
  if (filled) {
    return { from, to, text: fill(text) };
  }
  return { from, to, text };
}

// The installed copy's README and INSTALLED.json.
/** @param {{ repo: string, commit: string, dirty: string | null, at: string, shortSha: string }} install @returns {InstallFile[]} */
function generated({ repo, commit, dirty, at, shortSha }) {
  const installed = {
    repo,
    commit,
    dirty: Boolean(dirty),
    at,
    source: SRC.replace(HOME, "~"),
  };
  return [
    {
      from: GENERATED,
      to: path.join(ROOT, "README.md"),
      text: `# Issue pipeline (installed copy)

Installed from \`apps/issue-pipeline/\` of ${repo || "the pipeline's repo"} at ${shortSha}, ${at}.

Don't edit the code here: change it in the repo and run \`mise //apps/issue-pipeline:install\`, which overwrites these files. The per-repo configs in \`repos/\` (except \`example.json\`), their setup and teardown scripts, \`secrets/\`, \`clones/\`, \`work/\` and \`runs/\` are local and never installed. See \`apps/issue-pipeline/README.md\` in the repo for how it works.

Native compaction is pipeline-owned (175000 target, 30000 recent). Before any model launch, separately provision the trusted Pi/provider versions, dedicated runtime HOME, referenced credentials and reviewed discovery cache as documented in \`apps/issue-pipeline/runtime/README.md\`. Installation copies only a nonsecret example, never personal runtime files. Merging source activates nothing. The operator separately installs the accepted version and records this installed identity before resuming affected jobs. No provider/profile/cache/credentials are provisioned by installation.
`,
    },
    {
      from: GENERATED,
      to: path.join(ROOT, "INSTALLED.json"),
      text: `${JSON.stringify(installed, null, JSON_INDENT)}\n`,
    },
  ];
}

/** @param {string | null} old @param {string | null} text @returns {Status} */
function statusOf(old, text) {
  if (text === null) {
    return "retired";
  }
  if (old === null) {
    return "new";
  }
  if (old === text) {
    return "same";
  }
  return "updated";
}

// Writes `f`, first copying the file it replaces into `backup`.
/** @param {InstallFile} f @param {string | null} old @param {string} backup @returns {void} */
function write(f, old, backup) {
  if (old !== null && f.from !== GENERATED) {
    const copy = path.join(backup, path.relative(path.parse(f.to).root, f.to));
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, old);
  }
  if (f.text === null) {
    fs.rmSync(f.to);
    return;
  }
  fs.mkdirSync(path.dirname(f.to), { recursive: true });
  fs.writeFileSync(f.to, f.text);
}

// Lists each file's status and, unless a dry run, writes or removes it.
// Returns how many pipeline files (not generated ones) change.
/** @param {InstallFile[]} files @param {string} backup @returns {number} */
function install(files, backup) {
  let changed = 0;
  for (const f of files) {
    /** @type {string | null} */
    let old = null;
    if (fs.existsSync(f.to)) {
      old = fs.readFileSync(f.to, "utf8");
    }
    const status = statusOf(old, f.text);
    if (status !== "same" && f.from !== GENERATED) {
      changed += 1;
    }
    console.log(`${status.padEnd(STATUS_WIDTH)} ${f.to.replace(HOME, "~")}`);
    if (!dryRun && status !== "same") {
      write(f, old, backup);
    }
  }
  return changed;
}

// The retired files present, never a folder or a file `files` installs.
/** @param {InstallFile[]} files @returns {InstallFile[]} */
function retired(files) {
  const installed = new Set(files.map((f) => f.to));
  const agents = path.join(AGENT_DIR, "agents/issue-pipeline");
  return [
    path.join(ROOT, "workflow.js"),
    ...RETIRED_AGENTS.map((a) => path.join(agents, `issue-pipeline-${a}.md`)),
    path.join(AGENT_DIR, "prompts/pipeline-start.md"),
    path.join(AGENT_DIR, "prompts/pipeline-pause.md"),
  ]
    .filter((to) => !installed.has(to) && fs.existsSync(to))
    .filter((to) => fs.lstatSync(to).isFile())
    .map((to) => ({ from: RETIRED, to, text: null }));
}

/** @param {number} changed @param {string} shortSha @param {string} backup @returns {string} */
function outcome(changed, shortSha, backup) {
  if (dryRun) {
    return `dry run: ${changed} pipeline file(s) would change; nothing written`;
  }
  let where = "";
  if (changed) {
    where = `; replaced and retired files are in ${backup.replace(HOME, "~")}`;
  }
  return `installed ${shortSha}: ${changed} pipeline file(s) changed${where}`;
}

// Refuses to install from inside the pipeline root, from outside a git
// checkout, or with uncommitted changes unless allowed, then builds. Returns
// the commit and the uncommitted changes.
/** @returns {{ commit: string, dirty: string | null }} */
function checkedBuild() {
  if (real(SRC) === real(ROOT) || real(SRC).startsWith(real(ROOT) + path.sep)) {
    fail(
      `refusing to install from ${SRC}, inside the pipeline root; install from a checkout of your own`,
    );
  }
  const commit = git("rev-parse", "HEAD");
  if (!commit) {
    fail(`${SRC} is not in a git checkout`);
  }
  const dirty = git("status", "--porcelain", "--", ".");
  if (dirty && !allowDirty) {
    fail(
      `uncommitted changes in ${SRC}:\n${dirty}\nCommit them, or pass --allow-dirty`,
    );
  }
  const built = spawnSync(process.execPath, [path.join(SRC, "build.ts")], {
    cwd: SRC,
    stdio: "inherit",
  });
  if (built.status !== 0) {
    fail("build failed");
  }
  return { commit, dirty };
}

function main() {
  const { commit, dirty } = checkedBuild();
  const repo = (git("remote", "get-url", "origin") ?? "")
    .replace(GITHUB_PREFIX, "")
    .replace(GIT_SUFFIX, "");
  const files = sources().map(read);
  for (const f of files) {
    if (f.text?.includes("{{")) {
      fail(`${f.from} has a placeholder this script doesn't know`);
    }
  }
  files.push(...retired(files));
  const at = new Date().toISOString();
  let shortSha = commit.slice(0, SHORT_SHA_LENGTH);
  if (dirty) {
    shortSha += " (with uncommitted changes)";
  }
  files.push(...generated({ repo, commit, dirty, at, shortSha }));
  const stamp = at
    .replace(DATE_PUNCTUATION, "")
    .replace("T", "-")
    .slice(0, BACKUP_STAMP_LENGTH);
  const backup = path.join(`${ROOT}-backups`, `${stamp}-install`);
  const changed = install(files, backup);
  console.log(outcome(changed, shortSha, backup));
}

main();
