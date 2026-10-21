// @ts-check
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
import { credentialConfig } from "./credentials-test-kit.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";
import { seedOrigins } from "./job-git-test-kit.mjs";
import { setEnv } from "./ops-run-test-kit.mjs";
import { saveAuthority } from "./write-authority-test-kit.mjs";

/** @import { Config } from "../src/config.ts" */
/** @import { Stage } from "../src/stages.ts" */

const { newIssueState } = await import("../src/state.ts");
const { loadConfig, paths } = await import("../src/config.ts");
const { openJobCheckout } = await import("../src/job/checkout.ts");
const { openControl } = await import("../src/job/control.ts");
const { pushServerOf } = await import("../src/job/commit-push.ts");
const { openStatus, readStatus } = await import("../src/job/status.ts");
const { COMMIT_SCOPE_ENV, commitEnvOf } = await import(
  "../src/job/commit-scope.ts"
);
const { commitScopeOf } = await import("../src/job/roles.ts");
const { default: pipelineCommit } = await import(
  "../src/job/pipeline-commit-tool.ts"
);

// Every job folder and repo the tests make lives in the isolated root.
const root = isolatedRoot;
const ISSUE = 7;
const BRANCH = "refs/heads/agent/issue-7";
// The issue branch the job is assigned.
const ISSUE_BRANCH = "agent/issue-7";
const KEY = "i7-launch-1";
// The job's id and start, as the job's pushes and commits name them.
const JOB_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const JOB_STARTED_AT = "2026-10-17T12:00:00.000Z";

/**
 * One stage job's folder (root) with its code checkout (repo) and wiki
 * checkout (docs), its control socket and its registered tool.
 * @typedef {{ cfg: Config, root: string, repo: string, docs: string, branch: string, origin: string, wikiOrigin: string, runDir: string, socket: string, commit: (args: string[]) => Promise<any>, close: () => void }} Job
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

// Register the tool on a fake pi API, binding the session's environment.
/** @param {Record<string, string>} env @returns {(args: string[]) => Promise<any>} */
function committer(env) {
  /** @type {any[]} */
  const tools = [];
  pipelineCommit({ registerTool: (registered) => tools.push(registered) });
  const [tool] = tools;
  return async (args) => {
    setEnv(COMMIT_SCOPE_ENV, env[COMMIT_SCOPE_ENV] ?? "");
    return await tool.execute("call", { args });
  };
}

// Opens a job of `stage` for #7 of a repo of its own, with a wiki, whose
// launch KEY has started, recorded as given commit authority unless
// `commits` is false. With `withJobStart` false its commit scope lacks
// the job's start, as a job started before the trailer (#402) sends it.
/**
 * @param {Stage} stage
 * @param {{ withJobStart?: boolean, commits?: boolean, bindScope?: boolean, codeWritable?: boolean, allowed?: string[] }} [options]
 * @returns {Promise<Job>}
 */
async function openJob(
  stage,
  {
    withJobStart = true,
    commits = true,
    bindScope = true,
    codeWritable = true,
    allowed,
  } = {},
) {
  const tmp = fs.mkdtempSync(path.join(root, "repo-"));
  const cfg = configIn(tmp);
  const dirs = openJobCheckout(cfg, ISSUE, { stage, branch: ISSUE_BRANCH });
  if (dirs.docs === null) {
    throw new Error("the job has no wiki checkout");
  }
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
  const control = await openControl(runDir, pushServerOf(cfg, job, status));
  const sessionScope = scopeFor(stage, codeWritable, allowed);
  let boundScope = null;
  if (bindScope) {
    boundScope = sessionScope;
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
  /** @type {{ socket: string, key: string, root: string, jobStartedAt?: string }} */
  const scope = { socket: control.socket, key: KEY, root: dirs.root };
  if (withJobStart) {
    scope.jobStartedAt = JOB_STARTED_AT;
  }
  const env = commitEnvOf({ ...scope, ...sessionScope });
  return {
    cfg,
    root: dirs.root,
    repo: dirs.repo,
    docs: dirs.docs,
    branch: dirs.branch,
    origin: path.join(tmp, "origin.git"),
    wikiOrigin: path.join(tmp, "wiki-origin.git"),
    runDir,
    socket: control.socket,
    commit: committer(env),
    close: () => control.close(),
  };
}

/** @param {Stage} stage @param {boolean} codeWritable @param {string[] | undefined} allowed */
function scopeFor(stage, codeWritable, allowed) {
  const scope = commitScopeOf(stage, true, codeWritable);
  if (allowed !== undefined) {
    scope.allowed = allowed;
  }
  return scope;
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
