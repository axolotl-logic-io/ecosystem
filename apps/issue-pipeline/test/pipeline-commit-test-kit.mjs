// @ts-check
// pipeline_commit's integration tests' jobs, in-process against bare remotes:
// a real job checkout (openJobCheckout), the job's control socket serving
// pushes (openControl with pushServerOf), and the tool's default export
// registered on a fake pi API (Pipeline-Roles-Shared, "pipeline_commit").
// Importing it sets the pipeline root to a temp folder, so it comes before
// anything a test imports from src/.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { seedOrigins } from "./job-git-test-kit.mjs";
import { setEnv } from "./ops-run-test-kit.mjs";

/** @import { Config } from "../src/config.ts" */
/** @import { StageName } from "../src/workflow/stages/types.ts" */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-commit-push-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
setEnv("ISSUE_PIPELINE_ROOT", root);
const { loadConfig, paths } = await import("../src/config.ts");
const { openJobCheckout } = await import("../src/job/checkout.ts");
const { openControl } = await import("../src/job/control.ts");
const { pushServerOf } = await import("../src/job/commit-push.ts");
const { openStatus, readStatus } = await import("../src/job/status.ts");
const { COMMIT_SCOPE_ENV, commitEnvOf } = await import(
  "../src/job/pipeline-commit.ts"
);
const { commitScopeOf } = await import("../src/job/roles.ts");
const { default: pipelineCommit } = await import(
  "../src/job/pipeline-commit-tool.ts"
);

const ISSUE = 7;
const BRANCH = "refs/heads/agent/issue-7";
const KEY = "i7-launch-1";
// The job's id and start, as the job's pushes and commits name them.
const JOB_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const JOB_STARTED_AT = "2026-10-17T12:00:00.000Z";
const ZERO = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cost: 0,
};

/**
 * One stage job's folder (root) with its code checkout (repo) and wiki
 * checkout (docs), its control socket and its registered tool.
 * @typedef {{ cfg: Config, root: string, repo: string, docs: string, origin: string, wikiOrigin: string, runDir: string, commit: (args: string[]) => Promise<any>, close: () => void }} Job
 */

let repos = 0;

/**
 * git's trimmed stdout in `dir`.
 * @param {string} dir
 * @param {readonly string[]} args
 * @param {Record<string, string>} [env]
 * @returns {string}
 */
function git(dir, args, env = {}) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

/**
 * A config of a repo of its own, with a wiki unless `wiki` is false.
 * @param {string} tmp
 * @param {boolean} [wiki]
 * @returns {Config}
 */
function configIn(tmp, wiki = true) {
  repos += 1;
  const origins = seedOrigins(tmp, wiki);
  const file = path.join(tmp, "config.json");
  const config = {
    repo: `o/r${repos}`,
    account: "bot",
    allowedUsers: ["alice"],
    commands: { test: "true" },
    ...origins.config,
  };
  fs.writeFileSync(file, JSON.stringify(config));
  return loadConfig(file);
}

// The tool pipelineCommit registers on a fake pi API.
/** @returns {any} */
function registeredTool() {
  /** @type {any[]} */
  const tools = [];
  pipelineCommit({ registerTool: (tool) => tools.push(tool) });
  return tools[0];
}

// Opens a job of `stage` for #7 of a repo of its own, with a wiki, whose
// launch KEY has started.
/** @param {StageName} stage @returns {Promise<Job>} */
async function openJob(stage) {
  const tmp = fs.mkdtempSync(path.join(root, "repo-"));
  const cfg = configIn(tmp);
  const dirs = openJobCheckout(cfg, ISSUE, { stage, stackOn: null });
  if (dirs.docs === null) {
    throw new Error("the job has no wiki checkout");
  }
  const runDir = paths.runDir(cfg, ISSUE);
  const job = { issue: ISSUE, stage, checkout: dirs.repo, id: JOB_ID };
  const status = openStatus(runDir, {
    ...job,
    lane: null,
    socket: "",
    startedAt: JOB_STARTED_AT,
  });
  const server = pushServerOf(cfg, job, status.pushed);
  const control = await openControl(runDir, server);
  status.started({
    key: KEY,
    kind: "session",
    pid: null,
    session: null,
    resumed: false,
    usage: ZERO,
    tokenBudget: null,
  });
  const scope = {
    socket: control.socket,
    key: KEY,
    jobStartedAt: JOB_STARTED_AT,
    root: dirs.root,
  };
  const env = commitEnvOf({ ...scope, ...commitScopeOf(stage, true) });
  const tool = registeredTool();
  return {
    cfg,
    root: dirs.root,
    repo: dirs.repo,
    docs: dirs.docs,
    origin: path.join(tmp, "origin.git"),
    wikiOrigin: path.join(tmp, "wiki-origin.git"),
    runDir,
    commit: async (args) => {
      setEnv(COMMIT_SCOPE_ENV, env[COMMIT_SCOPE_ENV] ?? "");
      return await tool.execute("call", { args });
    },
    close: () => control.close(),
  };
}

// The pushes job.json records under the job's launch.
/** @param {Job} job @returns {{ repo: string, sha: string }[]} */
function pushesOf(job) {
  const pushes = readStatus(job.runDir)?.launches[0]?.pushes ?? [];
  return pushes.map(({ repo, sha }) => ({ repo, sha }));
}

/** @param {string} dir @param {string} file @param {string} text */
function write(dir, file, text) {
  fs.writeFileSync(path.join(dir, file), text);
}

/** @param {string} dir @returns {string} */
function headOf(dir) {
  return git(dir, ["rev-parse", "HEAD"]);
}

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
