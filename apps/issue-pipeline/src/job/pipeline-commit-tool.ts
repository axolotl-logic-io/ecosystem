// The pi extension that gives a stage job's writer session its only way to
// commit: the `pipeline_commit` tool (Pipeline-Job-Contract#pipeline_commit).
// `pi -e pipeline-commit.mjs` registers it; the session's
// ISSUE_PIPELINE_COMMIT_SCOPE (pipeline-commit.ts) names the job's folder,
// its code checkout there, what it may commit and the job to ask for the
// push. The tool runs the planner's
// git commands with ISSUE_PIPELINE_COMMIT=1, which the checkouts' pre-commit
// hook lets through, then asks the job over its control socket to push: the
// session holds no token and never pushes itself. Before committing, it
// stages the new files the call names exactly (#144), and nothing else.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { run } from "../process.ts";
import type { PushReply } from "./control-protocol.ts";
import { requestPush } from "./control-protocol.ts";
import type { CommitPlan, CommitScope } from "./pipeline-commit.ts";
import {
  COMMIT_TOOL,
  commitArgsOf,
  commitScopeIn,
  sessionTrailer,
} from "./pipeline-commit.ts";

const PARAMS = z.object({ args: z.array(z.string()) });
// git's own words for a commit with nothing in it, in the C locale.
const NOTHING_TO_COMMIT =
  /nothing (?:added )?to commit|no changes added to commit/u;
// The variables every planned git command runs with: the hook's pass, git's
// messages in English, and an editor that accepts the message as given.
const COMMIT_ENV: ReadonlyMap<string, string> = new Map([
  ["ISSUE_PIPELINE_COMMIT", "1"],
  ["LC_ALL", "C"],
  ["GIT_EDITOR", "true"],
]);
// A read that takes no optional index lock.
const READ_ONLY_ENV: ReadonlyMap<string, string> = new Map([
  ["GIT_OPTIONAL_LOCKS", "0"],
]);

// What git did in one repo: its last command's exit code and output, and the
// new head when the commit moved it.
interface RepoResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  sha: string | null;
}

// A planned commit in the code checkout: its argv and the call's pathspecs.
interface CommitStep {
  code: string[];
  paths: readonly string[];
}

// The tool's reply, as Pipeline-Job-Contract#pipeline_commit gives it.
interface CommitReply extends PushReply {
  code: RepoResult | null;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: CommitReply;
  isError: boolean;
}

interface CommitTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: unknown) => Promise<ToolResult>;
}

// The part of pi's ExtensionAPI this extension uses.
interface ExtensionApi {
  registerTool: (tool: CommitTool) => void;
}

function headOf(dir: string): string | null {
  const args = ["rev-parse", "--verify", "--quiet", "HEAD"];
  const found = run("git", args, { cwd: dir, allowFail: true });
  if (found.code !== 0) {
    return null;
  }
  return found.stdout.trim();
}

// The call's pathspecs in `dir` that name a new file exactly: untracked and
// not ignored. A directory, a pattern or the whole checkout names no new
// file, so it stages none, and an ignored file is never staged.
function newFilesIn(dir: string, paths: readonly string[]): string[] {
  if (paths.length === 0) {
    return [];
  }
  const listed = run(
    "git",
    [
      "--literal-pathspecs",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...paths,
    ],
    { cwd: dir, env: READ_ONLY_ENV },
  );
  const named = new Set(paths);
  return listed.stdout.split("\0").filter((file) => named.has(file));
}

// The git commands that commit as `plan` says in `dir`: staging the new
// files it names exactly, by their literal paths, then its commit.
function commandsIn(dir: string, plan: CommitStep): string[][] {
  const added = newFilesIn(dir, plan.paths);
  if (added.length === 0) {
    return [plan.code];
  }
  return [["--literal-pathspecs", "add", "--", ...added], plan.code];
}

// Runs a dry run's `argvs` in `dir` against a private copy of its index, so
// staging the new files it names leaves the checkout's index unchanged.
function dryRunIn(dir: string, argvs: readonly string[][]): RepoResult {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-commit-"));
  try {
    const index = path.join(tmp, "index");
    const where = run("git", ["rev-parse", "--git-path", "index"], {
      cwd: dir,
      env: READ_ONLY_ENV,
    });
    const actual = path.resolve(dir, where.stdout.trim());
    if (fs.existsSync(actual)) {
      fs.copyFileSync(actual, index);
    }
    return runIn(
      dir,
      argvs,
      new Map([...COMMIT_ENV, ["GIT_INDEX_FILE", index]]),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Runs `argvs` in `dir` in turn with `env`, stopping at the first that fails.
// A failure leaves what earlier commands staged in place.
function runIn(
  dir: string,
  argvs: readonly string[][],
  env: ReadonlyMap<string, string> = COMMIT_ENV,
): RepoResult {
  const before = headOf(dir);
  let last = { code: 0, stdout: "", stderr: "" };
  for (const argv of argvs) {
    last = run("git", argv, { cwd: dir, env, allowFail: true });
    if (last.code !== 0) {
      break;
    }
  }
  let sha: string | null = headOf(dir);
  if (sha === before) {
    sha = null;
  }
  return { exitCode: last.code, stdout: last.stdout, stderr: last.stderr, sha };
}

// True when git failed for a reason other than having nothing to commit.
function gitError(result: RepoResult | null): boolean {
  if (result === null || result.exitCode === 0) {
    return false;
  }
  return !NOTHING_TO_COMMIT.test(`${result.stdout}\n${result.stderr}`);
}

function failed(reply: CommitReply): ToolResult {
  const said: string[] = [];
  const result = reply.code;
  if (result !== null && result.exitCode !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim();
    said.push(`git exited ${result.exitCode}: ${output}`);
  }
  const text = `pipeline_commit failed, nothing was pushed.\n${said.join("\n")}`;
  return { content: [{ type: "text", text }], details: reply, isError: true };
}

// Commits as `plan` says in `scope`'s code checkout, and asks the job to
// push.
async function commitAndPush(
  plan: Extract<CommitPlan, { kind: "commit" }>,
  scope: CommitScope,
): Promise<ToolResult> {
  let code: RepoResult | null = null;
  if (plan.code !== null) {
    const dir = path.join(scope.root, scope.repo.dir);
    const commands = commandsIn(dir, { code: plan.code, paths: plan.paths });
    if (plan.dryRun && commands.length > 1) {
      code = dryRunIn(dir, commands);
    } else {
      code = runIn(dir, commands);
    }
  }
  const unpushed: CommitReply = { code, pushed: "none", pushError: null };
  const committed = typeof code?.sha === "string";
  const ranClean = code?.exitCode === 0;
  if (gitError(code)) {
    return failed(unpushed);
  }
  if (plan.dryRun && ranClean) {
    return succeeded(unpushed);
  }
  if (plan.dryRun || !committed) {
    return failed(unpushed);
  }
  return succeeded({
    code,
    ...(await requestPush(scope.socket, scope.key, scope.execution)),
  });
}

function succeeded(reply: CommitReply): ToolResult {
  const text = JSON.stringify(reply);
  return { content: [{ type: "text", text }], details: reply, isError: false };
}

async function execute(_id: string, params: unknown): Promise<ToolResult> {
  const scope = commitScopeIn(process.env);
  if (scope === null) {
    throw new Error("pipeline_commit: this session has no commit scope");
  }
  const parsed = PARAMS.safeParse(params);
  if (!parsed.success) {
    throw new Error(`pipeline_commit: ${z.prettifyError(parsed.error)}`);
  }
  const plan = commitArgsOf(parsed.data.args, scope, sessionTrailer(scope));
  if (plan.kind === "refused") {
    throw new Error(`pipeline_commit refused: ${plan.error}`);
  }
  return await commitAndPush(plan, scope);
}

// Registers the pipeline_commit tool.
function pipelineCommit(pi: ExtensionApi): void {
  pi.registerTool({
    name: COMMIT_TOOL,
    label: "Pipeline Commit",
    description:
      'Commit your work, and have the job push it. `args` are the arguments `git commit` would take, such as ["-am", "Add the parser"] or ["-m", "Fix", "--", "repo/src/a.ts"]. Paths, and a relative -F file, are relative to the job folder, your working directory: pathspecs start with repo/ (the code checkout, whose docs are in repo/docs/), and with none, the code checkout is committed. A path outside repo/, or into a checkout this stage only reads, is refused. A new file named exactly as a pathspec is staged for you (never run git add); a directory or pattern stages no new file, and an ignored file is never staged. A failed commit leaves those files staged and pushes nothing; --dry-run stages nothing. --amend, --no-verify/-n, --author, --date and --reset-author are refused. Never run git commit, push, rebase, reset, checkout or merge yourself.',
    promptSnippet: "Commit and push your work (the only way to commit)",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "The arguments git commit would take",
        },
      },
      required: ["args"],
    },
    execute,
  });
}

export type { CommitTool };
export default pipelineCommit;
