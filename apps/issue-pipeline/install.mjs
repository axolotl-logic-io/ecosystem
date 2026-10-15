#!/usr/bin/env node
// @ts-check
// Builds the issue pipeline from this folder's src/ into dist/ (build.ts; run
// `npm ci` at the repo root first), then installs it where pi reads it:
//
//   dist/workflow.js, dist/ops.mjs            -> $ISSUE_PIPELINE_ROOT (default ~/.pi/agent/issue-pipeline)
//   dist/job.mjs, dist/structured-output.mjs  -> $ISSUE_PIPELINE_ROOT (the stage job and its pi extension)
//   repos/example.json                        -> $ISSUE_PIPELINE_ROOT/repos/
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
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * A file to install: where it comes from (a path in this folder, or
 * GENERATED), where it goes, and its text.
 * @typedef {{ from: string, to: string, text: string }} InstallFile
 */
/**
 * A file this folder holds; `fill` replaces its placeholders.
 * @typedef {{ from: string, to: string, fill: boolean }} Source
 */
/** @typedef {"new" | "same" | "updated"} Status */

const GENERATED = "(generated)";
const SHORT_SHA_LENGTH = 7;
// The backup folder's stamp: yyyymmdd-hhmmss.
const BACKUP_STAMP_LENGTH = 15;
const JSON_INDENT = 2;
const STATUS_WIDTH = 8;
const GITHUB_PREFIX = /^.*github\.com[:/]/u;
const GIT_SUFFIX = /\.git$/u;
const DATE_PUNCTUATION = /[-:]/gu;

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

// The real path of `p`, or `p` when it doesn't exist.
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
    {
      from: "dist/workflow.js",
      to: path.join(ROOT, "workflow.js"),
      fill: false,
    },
    { from: "dist/ops.mjs", to: path.join(ROOT, "ops.mjs"), fill: false },
    { from: "dist/job.mjs", to: path.join(ROOT, "job.mjs"), fill: false },
    {
      from: "dist/structured-output.mjs",
      to: path.join(ROOT, "structured-output.mjs"),
      fill: false,
    },
    {
      from: "repos/example.json",
      to: path.join(ROOT, "repos/example.json"),
      fill: false,
    },
    ...mdIn("agents").map((f) => ({
      from: `agents/${f}`,
      to: path.join(AGENT_DIR, "agents/issue-pipeline", f),
      fill: true,
    })),
    ...mdIn("prompts").map((f) => ({
      from: `prompts/${f}`,
      to: path.join(AGENT_DIR, "prompts", f),
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

Don't edit the code here: change it in the repo and run \`mise //apps/issue-pipeline:install\`, which overwrites these files. The per-repo configs in \`repos/\` (except \`example.json\`), their setup and teardown scripts, \`secrets/\`, \`clones/\`, \`work/\` and \`runs/\` are local and never installed.

See \`apps/issue-pipeline/README.md\` in the repo for how it works.
`,
    },
    {
      from: GENERATED,
      to: path.join(ROOT, "INSTALLED.json"),
      text: `${JSON.stringify(installed, null, JSON_INDENT)}\n`,
    },
  ];
}

/** @param {string | null} old @param {string} text @returns {Status} */
function statusOf(old, text) {
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
  fs.mkdirSync(path.dirname(f.to), { recursive: true });
  fs.writeFileSync(f.to, f.text);
}

// Lists each file's status and, unless a dry run, writes the changed ones.
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

/** @param {number} changed @param {string} shortSha @param {string} backup @returns {string} */
function outcome(changed, shortSha, backup) {
  if (dryRun) {
    return `dry run: ${changed} pipeline file(s) would change; nothing written`;
  }
  let where = "";
  if (changed) {
    where = `; replaced files are in ${backup.replace(HOME, "~")}`;
  }
  return `installed ${shortSha}: ${changed} pipeline file(s) changed${where}`;
}

// Refuses to install from inside the pipeline root, from outside a git
// checkout, or with uncommitted changes unless allowed, then builds. Returns
// the commit and the uncommitted changes.
/** @returns {{ commit: string, dirty: string | null }} */
function checkedBuild() {
  // The pipeline's own worktrees live under the root, and agents work in them.
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
    if (f.text.includes("{{")) {
      fail(`${f.from} has a placeholder this script doesn't know`);
    }
  }

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
