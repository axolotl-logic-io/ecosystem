#!/usr/bin/env node
// Builds programs and installs prompts, examples and filled agent definitions.
// Every replaced file is backed up; operator config and work stay local.
// Only an operator-authorized install activates source changes.
// Usage: node install.ts [--dry-run] [--allow-dirty]
//   --dry-run      list what would change and write nothing
//   --allow-dirty  install even with uncommitted changes in this folder
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PROGRAMS } from "./programs.ts";

// A file to install from a path here or GENERATED; a Source is one this
// folder holds, `fill` to fill in.
interface InstallFile {
  from: string;
  to: string;
  text: string;
}
interface Source {
  from: string;
  to: string;
  fill: boolean;
}
type Status = "new" | "same" | "updated";

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
}: NodeJS.ProcessEnv = process.env;
const ROOT = path.resolve(
  rootVariable || path.join(HOME, ".pi/agent/issue-pipeline"),
);
const AGENT_DIR = path.resolve(
  agentDirVariable || path.join(HOME, ".pi/agent"),
);
const dryRun = process.argv.includes("--dry-run");
const allowDirty = process.argv.includes("--allow-dirty");

function fail(message: string): never {
  console.error(`install: ${message}`);
  process.exit(1);
}

function git(...args: string[]): string | null {
  const r = spawnSync("git", ["-C", SRC, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    return null;
  }
  return r.stdout.trim();
}

function real(p: string): string {
  if (!fs.existsSync(p)) {
    return p;
  }
  return fs.realpathSync(p);
}

function fill(text: string): string {
  return text
    .replaceAll("{{ISSUE_PIPELINE_ROOT}}", ROOT)
    .replaceAll("{{PI_CODING_AGENT_DIR}}", AGENT_DIR);
}

// The Markdown files in `base`'s folder `dir`, if any, relative to `base`.
function mdIn(base: string, dir: string): string[] {
  return fs.globSync(`${dir}/*.md`, { cwd: base }).sort();
}

function sources(): Source[] {
  const backend = fs
    .globSync("dist/vendor/node_modules/typescript-*/**/*", { cwd: SRC })
    .filter((file) => fs.statSync(path.join(SRC, file)).isFile())
    .sort();
  return [
    ...backend.map((from) => ({
      from,
      to: path.join(ROOT, path.relative("dist", from)),
      fill: false,
    })),
    ...PROGRAMS.map(({ file }) => ({
      from: `dist/${file}`,
      to: path.join(ROOT, file),
      fill: false,
    })),
    ...[
      "repos/example.json",
      "runtime/pi-cliproxyapi-config.example.json",
      "dist/standards-python-tools.txt",
      ...mdIn(SRC, "prompts"),
    ].map((from) => {
      let to = path.join(ROOT, from);
      if (from.startsWith("dist/")) {
        to = path.join(ROOT, path.relative("dist", from));
      }
      return { from, to, fill: false };
    }),
    ...mdIn(SRC, "agents").map((from) => ({
      from,
      to: path.join(AGENT_DIR, "agents/issue-pipeline", path.basename(from)),
      fill: true,
    })),
  ];
}

function read({ from, to, fill: filled }: Source): InstallFile {
  const text = fs.readFileSync(path.join(SRC, from), "utf8");
  if (filled) {
    return { from, to, text: fill(text) };
  }
  return { from, to, text };
}

// The installed copy's README and INSTALLED.json.
function generated({
  repo,
  commit,
  dirty,
  at,
  shortSha,
}: {
  repo: string;
  commit: string;
  dirty: string | null;
  at: string;
  shortSha: string;
}): InstallFile[] {
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

function statusOf(old: string | null, text: string): Status {
  if (old === null) {
    return "new";
  }
  if (old === text) {
    return "same";
  }
  return "updated";
}

// Writes `f`, first copying the file it replaces into `backup`.
function write(f: InstallFile, old: string | null, backup: string): void {
  if (old !== null && f.from !== GENERATED) {
    const copy = path.join(backup, path.relative(path.parse(f.to).root, f.to));
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, old);
  }
  fs.mkdirSync(path.dirname(f.to), { recursive: true });
  fs.writeFileSync(f.to, f.text);
}

// Lists each file's status and, unless a dry run, writes or removes it.
// Returns how many pipeline files (not generated ones) change.
function install(files: InstallFile[], backup: string): number {
  const changed: InstallFile[] = [];
  for (const f of files) {
    let old: string | null = null;
    if (fs.existsSync(f.to)) {
      old = fs.readFileSync(f.to, "utf8");
    }
    const status = statusOf(old, f.text);
    if (status !== "same" && f.from !== GENERATED) {
      changed.push(f);
    }
    console.log(`${status.padEnd(STATUS_WIDTH)} ${f.to.replace(HOME, "~")}`);
    if (!dryRun && status !== "same") {
      write(f, old, backup);
    }
  }
  return changed.length;
}

function outcome(changed: number, shortSha: string, backup: string): string {
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
function checkedBuild(): { commit: string; dirty: string | null } {
  if (real(SRC) === real(ROOT) || real(SRC).startsWith(real(ROOT) + path.sep)) {
    fail(
      `refusing to install from ${SRC}, inside the pipeline root; install from a checkout of your own`,
    );
  }
  const commit = git("rev-parse", "HEAD");
  if (commit === null || commit === "") {
    fail(`${SRC} is not in a git checkout`);
  }
  const dirty = git("status", "--porcelain", "--", ".");
  if (dirty !== null && dirty !== "" && !allowDirty) {
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

function main(): void {
  const { commit, dirty } = checkedBuild();
  const repo = (git("remote", "get-url", "origin") ?? "")
    .replace(GITHUB_PREFIX, "")
    .replace(GIT_SUFFIX, "");
  const files = sources().map(read);
  for (const f of files) {
    // Vendored compiler declarations contain literal template braces, not
    // agent-definition placeholders. They are copied without interpolation.
    if (
      f.text.includes("{{") &&
      !f.from.startsWith("dist/vendor/node_modules/typescript-")
    ) {
      fail(`${f.from} has a placeholder this script doesn't know`);
    }
  }
  const at = new Date().toISOString();
  let shortSha = commit.slice(0, SHORT_SHA_LENGTH);
  if (dirty !== null && dirty !== "") {
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
