// Git runs against a private metadata view, never the repository's config.
// This also removes include directives, aliases, fsmonitor, signing, helpers,
// pagers and future config-selected programs without a blacklist of settings.
import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Query } from "./git-review-policy.ts";

const MAX_OUTPUT_BYTES = 33_554_432;
const MAX_ERROR_LENGTH = 2000;
const TIMEOUT_MS = 30_000;
const SHA256 = /^\s*objectformat\s*=\s*sha256\s*$/imu;
const REFTABLE = /^\s*refstorage\s*=\s*reftable\s*$/imu;
const SHARED_INDEX = /^sharedindex\.[a-f0-9]+$/u;
const GIT = "/usr/bin/git";

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function rootsOf(roots: readonly string[]): string[] {
  return roots.map((root) => {
    if (!path.isAbsolute(root)) {
      throw new Error("Repository roots must be absolute paths");
    }
    const canonical = fs.realpathSync(root);
    const gitDir = path.join(canonical, ".git");
    if (!fs.lstatSync(gitDir).isDirectory()) {
      throw new Error(
        "Only repositories with a plain .git directory are supported",
      );
    }
    return canonical;
  });
}

function repositoryOf(cwd: string, roots: readonly string[]): string {
  if (!path.isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute allowlisted repository root");
  }
  const canonical = fs.realpathSync(cwd);
  if (!roots.includes(canonical)) {
    throw new Error("cwd must name an explicitly allowlisted repository root");
  }
  return canonical;
}

// Check existing ancestors too, so a missing file below an escaping symlink
// cannot bypass validation. Git receives literal pathspecs only.
function checkPaths(repo: string, paths: readonly string[]): void {
  for (const file of paths) {
    let current = path.resolve(repo, file);
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Unsupported path: ${file}`);
      }
      current = parent;
    }
    if (!inside(repo, fs.realpathSync(current))) {
      throw new Error(`Path leaves repository: ${file}`);
    }
  }
}

function assertPlainTree(dir: string): void {
  const info = fs.lstatSync(dir);
  if (info.isSymbolicLink() || !(info.isDirectory() || info.isFile())) {
    throw new Error("Symlink or special file in Git metadata is unsupported");
  }
  if (info.isDirectory()) {
    for (const child of fs.readdirSync(dir)) {
      assertPlainTree(path.join(dir, child));
    }
  }
}

function copyIfPresent(source: string, target: string): void {
  if (fs.existsSync(source)) {
    assertPlainTree(source);
    fs.cpSync(source, target, { recursive: true, dereference: false });
  }
}

function metadataView(repo: string, view: string): void {
  const source = path.join(repo, ".git");
  if (!fs.lstatSync(source).isDirectory()) {
    throw new Error("Git directory indirection is unsupported");
  }
  for (const name of [
    "commondir",
    "objects/info/alternates",
    "objects/info/http-alternates",
  ]) {
    if (fs.existsSync(path.join(source, name))) {
      throw new Error(`Unsupported Git metadata indirection: ${name}`);
    }
  }
  const configFile = path.join(source, "config");
  assertPlainTree(configFile);
  const config = fs.readFileSync(configFile, "utf8");
  if (REFTABLE.test(config)) {
    throw new Error("Reftable repositories are unsupported");
  }
  let format = "";
  if (SHA256.test(config)) {
    format = ["", "[extensions]", "objectformat = sha256", ""].join("\n");
  }
  fs.mkdirSync(view);
  fs.writeFileSync(
    path.join(view, "config"),
    `[core]\nrepositoryformatversion = 1\nbare = false\nlogAllRefUpdates = false\n${format}`,
  );
  for (const name of [
    "HEAD",
    "index",
    "refs",
    "packed-refs",
    "shallow",
    ...fs.readdirSync(source).filter((entry) => SHARED_INDEX.test(entry)),
  ]) {
    copyIfPresent(path.join(source, name), path.join(view, name));
  }
  const objects = path.join(source, "objects");
  assertPlainTree(objects);
  fs.symlinkSync(objects, path.join(view, "objects"), "dir");
}

// The environment is built from constants, not from the caller's environment.
// Exported so transport policy can be exercised without opening a network.
function gitEnvironment(home: string): Record<string, string> {
  return Object.fromEntries([
    ["PATH", "/usr/bin:/bin"],
    ["HOME", home],
    ["XDG_CONFIG_HOME", home],
    ["LC_ALL", "C"],
    ["TZ", "UTC"],
    ["GIT_CONFIG_GLOBAL", "/dev/null"],
    ["GIT_CONFIG_SYSTEM", "/dev/null"],
    ["GIT_CONFIG_NOSYSTEM", "1"],
    ["GIT_TERMINAL_PROMPT", "0"],
    ["GIT_ALLOW_PROTOCOL", "file"],
    ["GIT_NO_REPLACE_OBJECTS", "1"],
    ["GIT_OPTIONAL_LOCKS", "0"],
    ["GIT_ATTR_NOSYSTEM", "1"],
  ]);
}

function successful(query: Query, code: number | null): boolean {
  return (
    code === 0 ||
    (query.command === "grep" && code === 1) ||
    (query.command === "merge-base" &&
      query.args.includes("--is-ancestor") &&
      code === 1)
  );
}

function outputOf(output: Buffer[]): string {
  const bytes = Buffer.concat(output);
  if (!isUtf8(bytes)) {
    throw new Error("Git output is not UTF-8");
  }
  return bytes.toString("utf8");
}

function collect(
  repo: string,
  view: string,
  context: { home: string; query: Query },
  signal?: AbortSignal,
): Promise<string> {
  const { home, query } = context;
  return new Promise((resolve, reject) => {
    const child = spawn(
      GIT,
      [
        "--no-pager",
        "--literal-pathspecs",
        `--git-dir=${view}`,
        `--work-tree=${repo}`,
        ...query.args,
      ],
      {
        cwd: repo,
        env: gitEnvironment(home),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: TIMEOUT_MS,
        killSignal: "SIGKILL",
        signal,
      },
    );
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let oversized = false;
    let spawnError: Error | undefined;
    function receive(chunks: Buffer[], chunk: Buffer): void {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        oversized = true;
        child.kill("SIGKILL");
      } else {
        chunks.push(chunk);
      }
    }
    child.stdout.on("data", (chunk: Buffer): void => receive(output, chunk));
    child.stderr.on("data", (chunk: Buffer): void => receive(errors, chunk));
    child.on("error", (error: Error): void => {
      spawnError = error;
    });
    child.on("close", (code: number | null): void => {
      if (spawnError !== undefined) {
        reject(spawnError);
      } else if (oversized) {
        reject(
          new Error(
            "Git output exceeds the 32 MiB cache limit; narrow the query",
          ),
        );
      } else if (successful(query, code)) {
        try {
          resolve(outputOf(output));
        } catch {
          reject(new Error("Git output is not UTF-8; no lines served"));
        }
      } else {
        reject(
          new Error(
            `Git query failed (${code}): ${Buffer.concat(errors).toString("utf8").slice(0, MAX_ERROR_LENGTH)}`,
          ),
        );
      }
    });
  });
}

async function executeGit(
  repo: string,
  query: Query,
  signal?: AbortSignal,
): Promise<string> {
  checkPaths(repo, query.paths);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "git-review-"));
  const home = path.join(temporary, "home");
  const view = path.join(temporary, "repo.git");
  fs.mkdirSync(home);
  try {
    metadataView(repo, view);
    return await collect(repo, view, { home, query }, signal);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export { executeGit, gitEnvironment, repositoryOf, rootsOf };
