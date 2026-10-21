// @ts-check
// The stage job's test kit: `node src/job.ts` with a fake ops.mjs in a
// temporary pipeline root and a fake RPC `pi` first on PATH. Each logs what it
// was asked, so the tests see the ops in order, every pi command line and
// every RPC command pi got. A job startJob started, and every pi in the
// place's pi.log, are no longer running once the test ends.

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { endsWithTest, killGroup } from "./bounded-test-kit.mjs";
import { credentialConfig } from "./credentials-test-kit.mjs";
import { installJobAuthority } from "./fake-job-authority.mjs";
import { FAKE_PI } from "./fake-rpc-pi.mjs";
import { seedOrigins } from "./job-git-test-kit.mjs";
import { writePrompts } from "./prompt-test-kit.mjs";
import { provisionFixture } from "./runtime-fixtures.mjs";

const JOB = new URL("../src/job.ts", import.meta.url).pathname;
const AGENTS = new URL("../agents/", import.meta.url).pathname;
// runJob's bound on a job's run. A spawnSync blocks the event loop, and the
// per-test timeout with it, so this bound sits below that timeout
// (`--test-timeout` in mise.toml's check task); a run past it is killed and
// ends with a null status. It covers one job run to its end: the slowest
// measured was 8.2 s, in a full `node --test` run beside three more in a
// copy of the checkout, at 1-minute load averages of up to 130 on 10 cores
// (2026-10-17). It is over 3 times that.
const RUN_JOB_MS = 30_000;
// Where setUp makes each job's temporary folder, and its pipeline root.
const TEMPORARY_ROOT = "/tmp/issue-pipeline-job-";

/**
 * @typedef {object} Place
 * @property {string} tmp
 * @property {string} root
 * @property {string} bin
 * @property {string} config
 * @property {string} worktree
 * @property {string} runDir
 * @property {string} origin the repo's bare origin
 * @property {string | null} wikiOrigin the wiki's bare origin, if any
 * @property {string} prompts the root's prompts/ folder, holding every prompt
 * page
 */

/**
 * A fresh pipeline root, agent dir, worktree, fake bin and bare origin
 * seeded with a base commit for one job, with every prompt page in the
 * root's prompts/; with `wiki`, a wiki origin too.
 * @param {Record<string, unknown>} replies
 * @param {object} script
 * @param {Record<string, unknown>} [extraConfig] more config keys
 * @param {{ wiki?: boolean }} [options]
 * @returns {Place}
 */
function setUp(replies, script, extraConfig = {}, options = {}) {
  const tmp = fs.mkdtempSync(TEMPORARY_ROOT);
  process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "root");
  const bin = path.join(tmp, "bin");
  const agents = path.join(tmp, "agent", "agents", "issue-pipeline");
  const worktree = path.join(tmp, "work");
  for (const dir of [root, bin, agents, worktree, homeOf(tmp)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // The job runs in this root, never the machine's installed one.
  if (!(root.startsWith(TEMPORARY_ROOT) && fs.statSync(root).isDirectory())) {
    throw new Error(`the job's root ${root} isn't a temporary folder`);
  }
  for (const file of fs.readdirSync(AGENTS)) {
    fs.copyFileSync(path.join(AGENTS, file), path.join(agents, file));
  }
  installJobAuthority(root, bin, replies);
  fs.writeFileSync(path.join(bin, "pi"), FAKE_PI, { mode: 0o755 });
  const origins = seedOrigins(tmp, options.wiki === true);
  const config = path.join(root, "o__r.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo: "o/r",
      ...credentialConfig("bot"),
      allowedUsers: ["alice"],
      commands: { test: "true" },
      ...origins.config,
      runtime: provisionFixture(root),
      ...extraConfig,
    }),
  );
  fs.writeFileSync(path.join(root, "replies.json"), JSON.stringify(replies));
  const runDir = path.join(root, "runs", "o__r", "issue-7");
  const { origin, wikiOrigin } = origins;
  const place = {
    tmp,
    root,
    bin,
    config,
    worktree,
    runDir,
    origin,
    wikiOrigin,
    prompts: writePrompts(root),
  };
  setScript(place, script);
  endsWithTest(() => {
    // Each fake pi leads its own process group.
    for (const { pid } of piStarts(place)) {
      killGroup(pid);
    }
  });
  return place;
}

// The job's HOME, a folder of its own in the place's temporary folder.
/** @param {string} tmp @returns {string} */
function homeOf(tmp) {
  return path.join(tmp, "home");
}

/** @param {Place} place @param {object} script */
function setScript(place, script) {
  const file = path.join(place.root, "pi-script.json");
  fs.writeFileSync(file, JSON.stringify(script));
}

/**
 * @param {Place} place
 * @param {Record<string, string>} extraEnv
 * @returns {NodeJS.ProcessEnv}
 */
function jobEnv(place, extraEnv) {
  // A suite run inside a committing pipeline session leaves out that
  // session's commit scope, which no test's job is given.
  const {
    PATH: searchPath,
    ISSUE_PIPELINE_COMMIT_SCOPE: _sessionScope,
    ...inherited
  } = process.env;
  return {
    ...inherited,
    ...extraEnv,
    ...Object.fromEntries([
      ["PATH", `${place.bin}${path.delimiter}${searchPath}`],
      ["HOME", homeOf(place.tmp)],
      ["ISSUE_PIPELINE_ROOT", place.root],
      ["PI_CODING_AGENT_DIR", path.join(place.tmp, "agent")],
      ["FAKE_PI_ROOT", place.root],
      ["PIPELINE_MODEL_KEY", "offline-fixture-credential"],
    ]),
  };
}

// The branch the job tests assign issue #7: its own.
const ISSUE_BRANCH = "agent/issue-7";

// The job's argv for issue #7 with `args`, which with a stage assign it
// ISSUE_BRANCH unless they name their own.
/** @param {Place} place @param {readonly string[]} args @returns {string[]} */
function argvOf(place, args) {
  const argv = [JOB, "--config", place.config, "--issue", "7", ...args];
  if (!args.includes("--stage")) {
    return argv;
  }
  if (!args.some((arg) => arg.startsWith("--branch"))) {
    argv.push("--branch", ISSUE_BRANCH);
  }
  return argv;
}

/**
 * Runs the job to its end with `args` after its config and issue.
 * @param {Place} place
 * @param {readonly string[]} args
 * @param {Record<string, string>} [extraEnv] more job env
 */
function runJob(place, args, extraEnv = {}) {
  return spawnSync(process.execPath, argvOf(place, args), {
    encoding: "utf8",
    env: jobEnv(place, extraEnv),
    timeout: RUN_JOB_MS,
    killSignal: "SIGKILL",
  });
}

/**
 * @typedef {object} JobEnd
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Starts the job with `args` after its config and issue; `end` resolves
 * once it exits.
 * @param {Place} place
 * @param {readonly string[]} args
 * @param {Record<string, string>} [extraEnv] more job env
 * @returns {{ child: import("node:child_process").ChildProcess, end: Promise<JobEnd> }}
 */
function startJob(place, args, extraEnv = {}) {
  const child = spawn(process.execPath, argvOf(place, args), {
    env: jobEnv(place, extraEnv),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  endsWithTest(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });
  /** @type {Promise<JobEnd>} */
  const end = new Promise((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { child, end };
}

/**
 * The complete JSON lines of the root's log `name`, or none if it isn't
 * there; a line still being appended is left out.
 * @param {Place} place
 * @param {string} name
 * @returns {any[]}
 */
function logOf(place, name) {
  const file = path.join(place.root, name);
  if (!fs.existsSync(file)) {
    return [];
  }
  const text = fs.readFileSync(file, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line));
}

/** @param {Place} place @returns {any[]} pi's starts, in order */
function piStarts(place) {
  return logOf(place, "pi.log").filter((entry) => "argv" in entry);
}

/** @param {Place} place @returns {any[]} the RPC commands pi read */
function piCommands(place) {
  return logOf(place, "pi.log")
    .filter((entry) => "command" in entry)
    .map(({ command }) => command);
}

/** @param {Place} place @returns {any} the job's job.json, or null */
function statusOf(place) {
  const file = path.join(place.runDir, "job.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * @param {any} status a job.json, or null
 * @returns {any} its session's launch, or null
 */
function sessionOf(status) {
  return (
    status?.launches.find(
      (/** @type {{ kind: string }} */ { kind }) => kind === "session",
    ) ?? null
  );
}

/** @param {readonly string[]} argv @param {string} flag @returns {string} */
function flagValue(argv, flag) {
  return String(argv[argv.indexOf(flag) + 1]);
}

export {
  flagValue,
  logOf,
  piCommands,
  piStarts,
  runJob,
  sessionOf,
  setScript,
  setUp,
  startJob,
  statusOf,
};
