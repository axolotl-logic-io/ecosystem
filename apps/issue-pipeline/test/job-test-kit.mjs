// @ts-check
// The stage job's test kit: `node src/job.ts` with a fake ops.mjs in a
// temporary pipeline root and a fake RPC `pi` first on PATH. Each logs what it
// was asked, so the tests see the ops in order, every pi command line and
// every RPC command pi got.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { FAKE_OPS, FAKE_PI, messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import { seedOrigins } from "./job-git-test-kit.mjs";
import {
  claimAt,
  ISSUE,
  ROUTINE_OPS,
  sweepReply,
} from "./workflow-stages-fixtures.mjs";

const JOB = new URL("../src/job.ts", import.meta.url).pathname;
const AGENTS = new URL("../agents/", import.meta.url).pathname;
// How often waitFor looks at its file condition again.
const POLL_MS = 20;

// Issue #7 after triage: its plan and draft PR.
const TRIAGED = {
  plan: "Change src/a.ts and test it.",
  pr: 42,
  headSha: "aaaaaaa",
  implemented: false,
};
const SPEC = "## Behaviour\n\n1. src/a.ts does the thing.";
const USAGE = { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 400 };
const USAGE_TOTAL =
  USAGE.input + USAGE.output + USAGE.cacheRead + USAGE.cacheWrite;
// What USAGE counts as spent towards reportedTokens: cache reads left out.
const USAGE_SPENT = USAGE.input + USAGE.output + USAGE.cacheWrite;

// The structured output of a spec writer whose spec is ready.
const READY_SPEC = {
  decision: "ready",
  spec: `${SPEC}\n\n<!-- end of spec -->`,
  questions: [],
  files: ["src/a.ts"],
  subIssues: [],
};

// A session that spends USAGE and ends with the ready spec.
const SPEC_SESSION = { events: [messageEnd(USAGE), outputEnd(READY_SPEC)] };

/** @param {string} stage @returns {{ claim: object } & Record<string, unknown>} */
function repliesAt(stage) {
  return {
    ...ROUTINE_OPS,
    sweep: sweepReply({ items: [ISSUE] }),
    claim: claimAt(stage, TRIAGED),
  };
}

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
 */

/**
 * A fresh pipeline root, agent dir, worktree, fake bin and bare origin
 * seeded with a base commit for one job; with `wiki`, a wiki origin too.
 * @param {{ claim: { paths?: object } }} replies
 * @param {object} script
 * @param {Record<string, unknown>} [extraConfig] more config keys
 * @param {{ wiki?: boolean }} [options]
 * @returns {Place}
 */
function setUp(replies, script, extraConfig = {}, options = {}) {
  const tmp = fs.mkdtempSync("/tmp/issue-pipeline-job-");
  process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "root");
  const bin = path.join(tmp, "bin");
  const agents = path.join(tmp, "agent", "agents", "issue-pipeline");
  const worktree = path.join(tmp, "work");
  for (const dir of [root, bin, agents, worktree]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const file of fs.readdirSync(AGENTS)) {
    fs.copyFileSync(path.join(AGENTS, file), path.join(agents, file));
  }
  fs.writeFileSync(path.join(root, "ops.mjs"), FAKE_OPS);
  fs.writeFileSync(path.join(bin, "pi"), FAKE_PI, { mode: 0o755 });
  const origins = seedOrigins(tmp, options.wiki === true);
  const config = path.join(root, "o__r.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo: "o/r",
      account: "bot",
      allowedUsers: ["alice"],
      commands: { test: "true" },
      ...origins.config,
      ...extraConfig,
    }),
  );
  const claim = {
    ...replies.claim,
    paths: { ...replies.claim.paths, worktree },
  };
  fs.writeFileSync(
    path.join(root, "replies.json"),
    JSON.stringify({ ...replies, claim }),
  );
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
  };
  setScript(place, script);
  return place;
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
  const { PATH: searchPath } = process.env;
  return {
    ...process.env,
    ...extraEnv,
    ...Object.fromEntries([
      ["PATH", `${place.bin}${path.delimiter}${searchPath}`],
      ["ISSUE_PIPELINE_ROOT", place.root],
      ["PI_CODING_AGENT_DIR", path.join(place.tmp, "agent")],
      ["FAKE_PI_ROOT", place.root],
    ]),
  };
}

/** @param {Place} place @param {readonly string[]} args @returns {string[]} */
function argvOf(place, args) {
  return [JOB, "--config", place.config, "--issue", "7", ...args];
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
  /** @type {Promise<JobEnd>} */
  const end = new Promise((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { child, end };
}

/**
 * The JSON lines of the root's log `name`, or none if it isn't there.
 * @param {Place} place
 * @param {string} name
 * @returns {any[]}
 */
function logOf(place, name) {
  const file = path.join(place.root, name);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
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
 * Resolves once `check` holds, looking again every POLL_MS.
 * @param {() => boolean} check
 * @returns {Promise<void>}
 */
async function waitFor(check) {
  if (check()) {
    return;
  }
  await delay(POLL_MS);
  await waitFor(check);
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

/** @param {number} pid @returns {boolean} whether the process is running */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export {
  alive,
  flagValue,
  logOf,
  piCommands,
  piStarts,
  READY_SPEC,
  repliesAt,
  runJob,
  SPEC_SESSION,
  sessionOf,
  setScript,
  setUp,
  startJob,
  statusOf,
  USAGE,
  USAGE_SPENT,
  USAGE_TOTAL,
  waitFor,
};
