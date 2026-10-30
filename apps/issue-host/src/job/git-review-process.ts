// Git runs against a private metadata view, never the repository's config.
// This also removes include directives, aliases, fsmonitor, signing, helpers,
// pagers and future config-selected programs without a blacklist of settings.
import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Query } from "./git-review-policy.ts";
import { checkPaths, metadataView } from "./git-review-repository.ts";

const MAX_OUTPUT_BYTES = 33_554_432;
const MAX_ERROR_LENGTH = 2000;
const TIMEOUT_MS = 30_000;
const GIT = "/usr/bin/git";
const INDEX_ENTRY = /^(?<mode>\d{6}) [a-f0-9]+ [0-3]\t(?<file>[\s\S]+)$/u;
const WORKTREE_COMMANDS = new Set(["diff", "status", "grep", "blame"]);

interface GitEvidence {
  output: string;
  exitCode: number;
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
): Promise<GitEvidence> {
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
      } else if (code !== null && successful(query, code)) {
        try {
          resolve({ output: outputOf(output), exitCode: code });
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

// Implicit paths need the same authority check as explicit path arguments.
// Never let diff/status launch a child Git in an initialized submodule: that
// child would discover its own untrusted config instead of our private view.
async function checkWorktree(
  repo: string,
  view: string,
  context: { home: string; query: Query },
  signal?: AbortSignal,
): Promise<void> {
  if (!WORKTREE_COMMANDS.has(context.query.command)) {
    return;
  }
  const index = await collect(
    repo,
    view,
    {
      home: context.home,
      query: {
        command: "ls-files",
        args: ["ls-files", "--stage", "-z"],
        paths: [],
      },
    },
    signal,
  );
  for (const entry of index.output
    .split("\0")
    .filter((value) => value !== "")) {
    const { mode, file } = INDEX_ENTRY.exec(entry)?.groups ?? {};
    if (file === undefined) {
      throw new Error("Unsupported Git index entry");
    }
    checkPaths(repo, [file]);
    if (
      mode === "160000" &&
      (context.query.command === "diff" ||
        context.query.command === "status") &&
      fs.lstatSync(path.join(repo, file, ".git"), { throwIfNoEntry: false }) !==
        undefined
    ) {
      throw new Error(
        "diff/status with initialized submodules is unsupported; use show/log for committed evidence or review a standalone submodule clone as an explicitly allowed root",
      );
    }
  }
}

async function executeGit(
  repo: string,
  query: Query,
  signal?: AbortSignal,
): Promise<GitEvidence> {
  checkPaths(repo, query.paths);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "git-review-"));
  const home = path.join(temporary, "home");
  const view = path.join(temporary, "repo.git");
  fs.mkdirSync(home);
  try {
    metadataView(repo, view);
    const signals = [AbortSignal.timeout(TIMEOUT_MS)];
    if (signal !== undefined) {
      signals.push(signal);
    }
    const executionSignal = AbortSignal.any(signals);
    await checkWorktree(repo, view, { home, query }, executionSignal);
    return await collect(repo, view, { home, query }, executionSignal);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export type { GitEvidence };
export { executeGit, gitEnvironment };
