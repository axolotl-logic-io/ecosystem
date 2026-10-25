// pipeline_commit's integration tests' jobs, in-process against bare remotes:
// a real job checkout (openJobCheckout), the job's control socket serving
// pushes (openControl with pushServerOf), and the tool's default export
// registered on a fake pi API (Pipeline-Job-Contract#pipeline_commit).
// Importing it sets a temporary HOME and pipeline root (isolated-root-test-kit)
// before it loads src, so it comes before anything a test imports from src/.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Config } from "../src/config.ts";
import type { PathScope } from "../src/job/pipeline-commit.ts";
import type { CommitTool } from "../src/job/pipeline-commit-tool.ts";
import type { Stage } from "../src/stages.ts";
import { credentialConfig } from "./credentials-test-kit.ts";
import { isolatedRoot } from "./isolated-root-test-kit.ts";
import { TEST_BINDING } from "./job-fixtures.ts";
import { seedOrigin } from "./job-git-test-kit.ts";
import { setEnv } from "./ops-run-test-kit.ts";
import { saveAuthority } from "./write-authority-test-kit.ts";

const { newIssueState }: typeof import("../src/state.ts") = await import(
  "../src/state.ts"
);
const { loadConfig, paths }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const { openJobCheckout }: typeof import("../src/job/checkout.ts") =
  await import("../src/job/checkout.ts");
const { openControl }: typeof import("../src/job/control.ts") = await import(
  "../src/job/control.ts"
);
const { pushServerOf }: typeof import("../src/job/commit-push.ts") =
  await import("../src/job/commit-push.ts");
const { openStatus, readStatus }: typeof import("../src/job/status.ts") =
  await import("../src/job/status.ts");
const {
  COMMIT_SCOPE_ENV,
  commitEnvOf,
}: typeof import("../src/job/pipeline-commit.ts") = await import(
  "../src/job/pipeline-commit.ts"
);
const { commitScopeOf }: typeof import("../src/job/roles.ts") = await import(
  "../src/job/roles.ts"
);
const {
  default: pipelineCommit,
}: typeof import("../src/job/pipeline-commit-tool.ts") = await import(
  "../src/job/pipeline-commit-tool.ts"
);

// Every job folder and repo the tests make lives in the isolated root.
const root: string = isolatedRoot;
const ISSUE = 7;
const BRANCH = "refs/heads/agent/issue-7";
// The issue branch the job is assigned.
const ISSUE_BRANCH = "agent/issue-7";
const KEY = "i7-launch-1";
// The job's id and start, as the job's pushes and commits name them.
const JOB_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const JOB_STARTED_AT = "2026-10-17T12:00:00.000Z";

// pipeline_commit's result: its text, its reply as details (what it
// committed and pushed) and whether it failed.
type CommitResult = Awaited<ReturnType<CommitTool["execute"]>>;

// One stage job's folder (root) with its code checkout (repo), its control
// socket and its registered tool.
interface Job {
  cfg: Config;
  root: string;
  repo: string;
  branch: string;
  origin: string;
  runDir: string;
  socket: string;
  commit: (args: string[]) => Promise<CommitResult>;
  close: () => void;
}

let repos = 0;

// git's trimmed stdout in `dir`.
function git(
  dir: string,
  args: readonly string[],
  env: Record<string, string> = {},
): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

// A config of a repo of its own.
function configIn(tmp: string): Config {
  repos += 1;
  const origins = seedOrigin(tmp);
  const file = path.join(tmp, "config.json");
  const config = {
    repo: `o/r${repos}`,
    ...credentialConfig("bot"),
    allowedUsers: ["alice"],
    commands: { test: "true" },
    ...origins.config,
  };
  fs.writeFileSync(file, JSON.stringify(config));
  const cfg = loadConfig(file);
  saveAuthority(cfg, {
    ...newIssueState(ISSUE),
    stage: "implement",
    branch: ISSUE_BRANCH,
  });
  return cfg;
}

// The tool pipelineCommit registers on a fake pi API.
function registeredTool(): CommitTool {
  const tools: CommitTool[] = [];
  pipelineCommit({ registerTool: (tool: CommitTool) => tools.push(tool) });
  const [registered] = tools;
  if (registered === undefined) {
    throw new Error("pipeline_commit registered no tool");
  }
  return registered;
}

// Opens a job of `stage` for #7 of a repo of its own, whose
// launch KEY has started, recorded as given commit authority unless
// `commits` is false. With `withJobStart` false its commit scope lacks
// the job's start, as a job started before the trailer (#402) sends it.
async function openJob(
  stage: Stage,
  {
    withJobStart = true,
    commits = true,
    bindScope = true,
  }: { withJobStart?: boolean; commits?: boolean; bindScope?: boolean } = {},
): Promise<Job> {
  const tmp = fs.mkdtempSync(path.join(root, "repo-"));
  const cfg = configIn(tmp);
  const dirs = openJobCheckout(cfg, ISSUE, { stage, branch: ISSUE_BRANCH });
  const runDir = paths.runDir(cfg, ISSUE);
  const job = {
    issue: ISSUE,
    stage,
    checkout: dirs.repo,
    branch: ISSUE_BRANCH,
    id: JOB_ID,
  };
  const status = openStatus(runDir, {
    ...job,
    lane: null,
    socket: "",
    startedAt: JOB_STARTED_AT,
    prompts: [],
  });
  // These pushes test write authority; invocation ownership is
  // job/job-binding-fence.test.ts's.
  const owned = { ...job, owner: (): undefined => undefined };
  const control = await openControl(
    runDir,
    pushServerOf(cfg, owned, status),
    TEST_BINDING,
  );
  let boundScope: PathScope | null = null;
  if (bindScope === true) {
    boundScope = commitScopeOf(stage, true);
  }
  status.started({
    key: KEY,
    kind: "session",
    pid: null,
    session: null,
    commits,
    phase: null,
    scope: boundScope,
  });
  const scope: {
    socket: string;
    key: string;
    root: string;
    execution: typeof TEST_BINDING;
    jobStartedAt?: string;
  } = {
    socket: control.socket,
    key: KEY,
    root: dirs.root,
    execution: TEST_BINDING,
  };
  if (withJobStart === true) {
    scope.jobStartedAt = JOB_STARTED_AT;
  }
  const env = commitEnvOf({ ...scope, ...commitScopeOf(stage, true) });
  const tool = registeredTool();
  return {
    cfg,
    root: dirs.root,
    repo: dirs.repo,
    branch: dirs.branch,
    origin: path.join(tmp, "origin.git"),
    runDir,
    socket: control.socket,
    commit: async (args: string[]): Promise<CommitResult> => {
      setEnv(COMMIT_SCOPE_ENV, env[COMMIT_SCOPE_ENV] ?? "");
      return await tool.execute("call", { args });
    },
    close: () => control.close(),
  };
}

// The pushes job.json records under the job's launch.
function pushesOf(job: Job): { repo: string; sha: string }[] {
  const pushes = readStatus(job.runDir)?.launches[0]?.pushes ?? [];
  return pushes.map(({ repo, sha }) => ({ repo, sha }));
}

function write(dir: string, file: string, text: string): void {
  fs.writeFileSync(path.join(dir, file), text);
}

function headOf(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]);
}

export type { CommitResult, Job };
export {
  BRANCH,
  configIn,
  git,
  headOf,
  ISSUE,
  JOB_ID,
  JOB_STARTED_AT,
  KEY,
  openJob,
  pushesOf,
  root,
  write,
};
