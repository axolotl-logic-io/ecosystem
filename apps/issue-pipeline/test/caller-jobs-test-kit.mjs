// @ts-check
// A world for tests of the caller's launcher, scripts/caller-jobs.ts: a
// temporary pipeline root whose job.mjs is a fake stage job, a fake gh that
// shows the test issues' states, a config for repo o/r with fake credentials
// and a fake model env file. The fake job records its argv and the variables
// it got, opens job.json with src/job/status.ts as the real job does, then
// waits for `release(issue, end)` and ends that way: with an `end` value, or
// with "crash", failing without a result line. Every job a test starts is
// killed when it ends. Every launcher runs under a spy that records any read
// of the model env file.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { endsWithTest, killGroup } from "./bounded-test-kit.mjs";
import { credentialConfig } from "./credentials-test-kit.mjs";
import { installFakeGh } from "./fake-gh.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

const LAUNCHER = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "caller-jobs.ts",
);
const STATUS_MODULE = pathToFileURL(
  path.join(import.meta.dirname, "..", "src", "job", "status.ts"),
).href;
const SLUG = "o__r";
// The test issues, which GitHub shows open unless a test closes one.
const ISSUE = 7;
const SECOND_ISSUE = 8;
const THIRD_ISSUE = 9;
const FOURTH_ISSUE = 10;
const ISSUES = [ISSUE, SECOND_ISSUE, THIRD_ISSUE, FOURTH_ISSUE];
// How long a launcher command may take before the test fails.
const LAUNCHER_MS = 30_000;
// How long the fake job waits for its release before it fails on its own.
const FAKE_JOB_MS = 20_000;

fs.writeFileSync(
  path.join(isolatedRoot, "job.mjs"),
  `import fs from "node:fs";
import path from "node:path";
const { openStatus } = await import(${JSON.stringify(STATUS_MODULE)});
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const issue = Number(flag("--issue"));
const stage = flag("--stage");
const here = import.meta.dirname;
fs.writeFileSync(path.join(here, "seen-" + issue + ".json"), JSON.stringify({
  argv,
  ghToken: process.env.GH_TOKEN ?? null,
  modelKey: process.env.FAKE_MODEL_KEY ?? null,
}));
const runDir = path.join(here, "runs", ${JSON.stringify(SLUG)}, "issue-" + issue);
fs.mkdirSync(runDir, { recursive: true });
const status = openStatus(runDir, {
  id: flag("--job-id"), issue, stage, lane: flag("--lane"),
  startedAt: new Date().toISOString(), socket: "/s", prompts: [],
});
const release = path.join(here, "release-" + issue);
const deadline = Date.now() + ${FAKE_JOB_MS};
while (!fs.existsSync(release) && Date.now() < deadline) {
  await new Promise((done) => setTimeout(done, 20));
}
let end = "crash";
if (fs.existsSync(release)) end = fs.readFileSync(release, "utf8");
if (end === "crash") {
  process.stderr.write("fake job failed\\n");
  process.exit(1);
}
status.finish({ kind: "finished", end });
process.stdout.write(JSON.stringify({ issue, stage, end }) + "\\n");
`,
);

const gh = installFakeGh();
const { credentialsEnvFile, devAccount, mergeAccount } = credentialConfig();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "caller-jobs-"));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
const CONFIG = path.join(work, "o-r.json");
fs.writeFileSync(
  CONFIG,
  JSON.stringify({
    repo: "o/r",
    credentialsEnvFile,
    devAccount,
    mergeAccount,
    allowedUsers: ["alice"],
    commands: { test: "true" },
  }),
);
const MODEL_ENV = path.join(work, "model.env");
fs.writeFileSync(MODEL_ENV, "FAKE_MODEL_KEY=fake-model-key\n");
// Each launcher runs with this module first. It wraps the fs calls that
// open or read a file so that any on MODEL_ENV is recorded in MODEL_READS;
// the job's own Node, which loads the file, runs without it.
const MODEL_READS = path.join(work, "model-reads.log");
const FS_SPY = path.join(work, "fs-spy.mjs");
fs.writeFileSync(
  FS_SPY,
  `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const watched = ${JSON.stringify(MODEL_ENV)};
for (const name of ["open", "openSync", "readFile", "readFileSync", "createReadStream"]) {
  const real = fs[name];
  fs[name] = function (file, ...rest) {
    if (String(file) === watched) fs.appendFileSync(${JSON.stringify(MODEL_READS)}, name + "\\n");
    return real.call(this, file, ...rest);
  };
}
for (const name of ["open", "readFile"]) {
  const real = fs.promises[name];
  fs.promises[name] = function (file, ...rest) {
    if (String(file) === watched) fs.appendFileSync(${JSON.stringify(MODEL_READS)}, name + "\\n");
    return real.call(this, file, ...rest);
  };
}
syncBuiltinESMExports();
`,
);

/** @param {readonly number[]} [closed] the issues GitHub shows closed */
function issuesOnGitHub(closed = []) {
  gh.reply(
    ISSUES.map((issue) => {
      let state = "open";
      if (closed.includes(issue)) {
        state = "closed";
      }
      return {
        when: `repos/o/r/issues/${issue}`,
        stdout: JSON.stringify({ state }),
        keep: true,
      };
    }),
  );
}

let runs = 0;

/**
 * A fresh run folder, with `limits` over 3 jobs and 2 attempts in its
 * run.json.
 * @param {Record<string, unknown>} limits
 * @returns {string}
 */
function runFolder(limits) {
  runs += 1;
  const dir = path.join(work, `run-${runs}`);
  fs.mkdirSync(dir);
  setLimits(dir, limits);
  return dir;
}

/**
 * Writes `limits` over 3 jobs and 2 attempts to `run`'s run.json.
 * @param {string} run @param {Record<string, unknown>} limits
 */
function setLimits(run, limits) {
  fs.writeFileSync(
    path.join(run, "run.json"),
    JSON.stringify({ maxJobs: 3, maxAttempts: 2, ...limits }),
  );
}

/**
 * A fresh run folder, and the pipeline root emptied of earlier tests' jobs.
 * @param {Record<string, unknown>} limits
 * @returns {string}
 */
function newRun(limits) {
  for (const file of fs.readdirSync(isolatedRoot)) {
    if (file.startsWith("release-") || file.startsWith("seen-")) {
      fs.rmSync(path.join(isolatedRoot, file));
    }
  }
  fs.rmSync(path.join(isolatedRoot, "runs"), { recursive: true, force: true });
  return runFolder(limits);
}

/**
 * Runs the launcher with `args`, the outer environment holding a GitHub
 * token the job mustn't get.
 * @param {readonly string[]} args
 */
function launcher(args) {
  const result = spawnSync(process.execPath, launcherArgv(args), {
    encoding: "utf8",
    env: {
      ...process.env,
      ...Object.fromEntries([["GH_TOKEN", "outer-token"]]),
    },
    timeout: LAUNCHER_MS,
  });
  return {
    code: result.status,
    lines: linesOf(result.stdout),
    stderr: result.stderr,
  };
}

/**
 * Why the launcher refused, as its stderr says.
 * @param {{ stderr: string }} out
 * @returns {string}
 */
function refusal(out) {
  return out.stderr.replace("caller-jobs: refused: ", "").trimEnd();
}

/**
 * Node's argv for the launcher with `args`, under the fs spy.
 * @param {readonly string[]} args
 * @returns {string[]}
 */
function launcherArgv(args) {
  return [`--import=${pathToFileURL(FS_SPY).href}`, LAUNCHER, ...args];
}

/** @returns {string[]} the fs calls launchers made on MODEL_ENV */
function modelFileReads() {
  if (!fs.existsSync(MODEL_READS)) {
    return [];
  }
  return fs.readFileSync(MODEL_READS, "utf8").split("\n").filter(Boolean);
}

/** @param {string} text @returns {any[]} its JSON lines */
function linesOf(text) {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Starts `stage` of `issue` on branch issue-N in lane L of `run`.
 * @param {string} run @param {number} issue @param {string} stage
 * @param {readonly string[]} [extra] more launcher arguments
 */
function start(run, issue, stage, extra = []) {
  const out = launcher([
    "start",
    "--run",
    run,
    "--config",
    CONFIG,
    "--issue",
    String(issue),
    "--branch",
    `issue-${issue}`,
    "--lane",
    "L",
    "--stage",
    stage,
    ...extra,
  ]);
  for (const line of out.lines) {
    endsWithTest(() => killGroup(line.pid));
  }
  return out;
}

/** @param {number} issue @param {string} end */
function release(issue, end) {
  fs.writeFileSync(path.join(isolatedRoot, `release-${issue}`), end);
}

/** @param {number} issue @returns {boolean} whether its fake job has run */
function hasStarted(issue) {
  return fs.existsSync(path.join(isolatedRoot, `seen-${issue}.json`));
}

/** @param {number} issue */
function seenBy(issue) {
  return JSON.parse(
    fs.readFileSync(path.join(isolatedRoot, `seen-${issue}.json`), "utf8"),
  );
}

/** @param {number} issue @returns {boolean} whether its job.json is there */
function hasStatusFile(issue) {
  const file = path.join(isolatedRoot, "runs", SLUG, `issue-${issue}`);
  return fs.existsSync(path.join(file, "job.json"));
}

/**
 * @param {string} run
 * @returns {unknown[]} the receipt files it holds, without the copy of its
 * first limits
 */
function receiptsOf(run) {
  const jobs = path.join(run, "jobs");
  if (!fs.existsSync(jobs)) {
    return [];
  }
  return fs
    .readdirSync(jobs, { recursive: true })
    .filter((file) => file !== "limits.json");
}

export {
  CONFIG,
  FOURTH_ISSUE,
  gh,
  hasStarted,
  hasStatusFile,
  ISSUE,
  issuesOnGitHub,
  launcher,
  launcherArgv,
  linesOf,
  MODEL_ENV,
  modelFileReads,
  newRun,
  receiptsOf,
  refusal,
  release,
  runFolder,
  SECOND_ISSUE,
  SLUG,
  seenBy,
  setLimits,
  start,
  THIRD_ISSUE,
};
