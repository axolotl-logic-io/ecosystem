// The pi extension that gives a stage job's writer session its only way to
// commit: the `pipeline_commit` tool (Pipeline-Roles-Shared,
// "pipeline_commit"). `pi -e pipeline-commit.mjs` registers it; the session's
// ISSUE_PIPELINE_COMMIT_SCOPE (pipeline-commit.ts) names its checkout, what
// it may commit and the job to ask for the push. The tool runs the planner's
// git commands with ISSUE_PIPELINE_COMMIT=1, which the checkouts' pre-commit
// hook lets through, then asks the job over its control socket to push: the
// session holds no token and never pushes itself.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { run } from "../process.ts";
import type { PushReply } from "./control-protocol.ts";
import { requestPush } from "./control-protocol.ts";
import type { CommitPlan, CommitScope } from "./pipeline-commit.ts";
import { COMMIT_TOOL, commitArgsOf, commitScopeIn } from "./pipeline-commit.ts";

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

// What git did in one repo: its last command's exit code and output, and the
// new head when the commit moved it.
interface RepoResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  sha: string | null;
}

// The tool's reply, as Pipeline-Roles-Shared gives it.
interface CommitReply extends PushReply {
  code: RepoResult | null;
  wiki: RepoResult | null;
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

// Runs `argvs` in `dir` in turn, stopping at the first that fails.
function runIn(dir: string, argvs: readonly string[][]): RepoResult {
  const before = headOf(dir);
  let last = { code: 0, stdout: "", stderr: "" };
  for (const argv of argvs) {
    last = run("git", argv, { cwd: dir, env: COMMIT_ENV, allowFail: true });
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

// The wiki checkout's folder, or null when the plan or the checkout has none.
function wikiFolder(scope: CommitScope): string | null {
  if (scope.wikiDir === null) {
    return null;
  }
  const dir = path.join(scope.checkout, scope.wikiDir);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    return null;
  }
  return dir;
}

function failed(reply: CommitReply): ToolResult {
  const said: string[] = [];
  for (const result of [reply.code, reply.wiki]) {
    if (result !== null && result.exitCode !== 0) {
      const output = `${result.stdout}${result.stderr}`.trim();
      said.push(`git exited ${result.exitCode}: ${output}`);
    }
  }
  const text = `pipeline_commit failed, nothing was pushed.\n${said.join("\n")}`;
  return { content: [{ type: "text", text }], details: reply, isError: true };
}

// Commits as `plan` says in `scope`'s checkouts, and asks the job to push.
async function commitAndPush(
  plan: Extract<CommitPlan, { kind: "commit" }>,
  scope: CommitScope,
): Promise<ToolResult> {
  let code: RepoResult | null = null;
  if (plan.code !== null) {
    code = runIn(scope.checkout, [plan.code]);
  }
  const wikiDir = wikiFolder(scope);
  let wiki: RepoResult | null = null;
  if (plan.wiki !== null && wikiDir !== null) {
    wiki = runIn(wikiDir, plan.wiki);
  }
  const unpushed: CommitReply = { code, wiki, pushed: "none", pushError: null };
  const committed = [code, wiki].some(
    (result) => typeof result?.sha === "string",
  );
  const ranClean = [code, wiki].some((result) => result?.exitCode === 0);
  if (gitError(code) || gitError(wiki)) {
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
    wiki,
    ...(await requestPush(scope.socket, scope.key)),
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
  const plan = commitArgsOf(parsed.data.args, scope);
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
      'Commit your work, and have the job push it. `args` are the arguments `git commit` would take, such as ["-am", "Add the parser"] or ["-m", "Fix", "--", "src/a.ts"]. Wiki paths are committed in the wiki checkout when this stage may write it. --amend, --no-verify/-n, --author, --date and --reset-author are refused. Never run git commit, push, rebase, reset, checkout or merge yourself.',
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

export default pipelineCommit;
