// @ts-check
// The full-flow tests' clock: one tick runs the built orchestrator once
// (`orchestrate.mjs --once`) and waits for every job it started to exit;
// stagesUntilIdle ticks until a tick starts nothing. Each job's pid is kept
// on the flow, and stopJobs kills any still running when the test ends.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { endsWithTest, killGroup } from "./bounded-test-kit.mjs";
import { readWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { savedState } from "./pipeline-flow-script-test-kit.mjs";
import { ISSUE, SLUG } from "./pipeline-flow-test-kit.mjs";

// Bound each stage, not a whole multi-stage fixture. Verification of #95
// measured stages exceeding the old 60 s bound (an isolated author alone
// took 38 s). Allow startup/IO contention below the unchanged 180 s test
// timeout; a timed-out stage must be killed before another stage can start.
const RUN_MS = 120_000;
const POLL_MS = 50;
// A flow ends within this many ticks, or the test fails.
const MAX_TICKS = 12;
const CALLER_LAUNCH = z.object({ pid: z.number(), receipt: z.string() });
const JOB_RESULT = z.looseObject({
  issue: z.number(),
  stage: z.string(),
  end: z.string(),
  claimError: z.string().optional(),
});

/** @param {number} pid @returns {boolean} */
function isLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} file @returns {any[]} its JSON lines, none if missing */
function jsonLines(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/**
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @returns {{ issue: number, stage: string, pid: number }[]}
 */
function startsOf(flow) {
  const file = path.join(flow.root, "runs", SLUG, "starts.json");
  if (!fs.existsSync(file)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Resolves once none of `pids` runs, or rejects past `deadline`.
 * @param {readonly number[]} pids @param {number} deadline
 * @returns {Promise<void>}
 */
async function untilExited(pids, deadline) {
  if (!pids.some(isLive)) {
    return;
  }
  if (performance.now() >= deadline) {
    throw new Error(`jobs ${pids.join(", ")} ran past ${RUN_MS} ms`);
  }
  await delay(POLL_MS);
  await untilExited(pids, deadline);
}

/**
 * Runs one orchestrator tick, then waits for every job it started to exit.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @returns {Promise<{ started: string[], log: any[] }>} the stages it
 * started and the tick's orchestrator log lines
 */
async function tick(flow) {
  const deadline = performance.now() + RUN_MS;
  const logFile = path.join(flow.root, "runs", SLUG, "orchestrator.log");
  const before = jsonLines(logFile).length;
  const known = new Set(flow.pids);
  const orchestrate = path.join(flow.root, "orchestrate.mjs");
  const result = spawnSync(
    process.execPath,
    [orchestrate, "--config", flow.config, "--once"],
    { env: flow.env, encoding: "utf8", timeout: RUN_MS, killSignal: "SIGKILL" },
  );
  if (result.status !== 0) {
    throw new Error(`orchestrate exited ${result.status}: ${result.stderr}`);
  }
  const fresh = startsOf(flow).filter(({ pid }) => !known.has(pid));
  const pids = fresh.map(({ pid }) => pid);
  flow.pids.push(...pids);
  const pending = new Set(pids);
  endsWithTest(() => {
    for (const pid of pending) {
      killGroup(pid);
    }
  });
  await untilExited(pids, deadline);
  pending.clear();
  return {
    started: fresh.map(({ stage }) => stage),
    log: jsonLines(logFile).slice(before),
  };
}

/**
 * Runs exactly the caller's assigned issue/stage/branch; no discovery or sweep.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {string} stage
 * @param {number} [issue]
 * @param {readonly string[]} [extra] more job arguments
 * @returns {any} the job's line: issue, stage, end, and any reason, request
 * or task report
 */
function runStage(flow, stage, issue = ISSUE, extra = []) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(flow.root, "job.mjs"),
      "--config",
      flow.config,
      "--issue",
      String(issue),
      "--branch",
      `agent/issue-${issue}`,
      "--stage",
      stage,
      "--lane",
      "flow-caller",
      ...extra,
    ],
    { env: flow.env, encoding: "utf8", timeout: RUN_MS, killSignal: "SIGKILL" },
  );
  if (result.status !== 0) {
    throw new Error(`job exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Runs the task a stage job's line requested (#186), as the caller relays
 * it: the task job at the same stage, with the request's exact binding, in
 * `lane` (the stage jobs' own lane, so their lease never holds it).
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {string} stage the saved stage the request was made at
 * @param {{ task: string, binding: unknown }} request
 * @param {{ issue?: number, lane?: string }} [options]
 * @returns {any} the task job's line
 */
function runTask(flow, stage, request, { issue = ISSUE, lane } = {}) {
  const extra = [
    "--task",
    request.task.toLowerCase(),
    "--binding",
    JSON.stringify(request.binding),
  ];
  if (lane !== undefined) {
    extra.push("--lane", lane);
  }
  return runStage(flow, stage, issue, extra);
}

/**
 * Runs `stage`, relaying each task its job requests and rerunning `stage`
 * while the issue is still saved there, until a job ends without a request
 * or a task moves the issue on (a passed Sync goes back to review). Returns
 * every line, in order: stage jobs' and task jobs'.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {string} stage
 * @param {{ issue?: number, extra?: readonly string[], limit?: number }} [options]
 * @returns {any[]}
 */
function runThroughTasks(
  flow,
  stage,
  { issue = ISSUE, extra = [], limit = 6 } = {},
) {
  /** @type {any[]} */
  const lines = [];
  for (let turn = 0; turn < limit; turn += 1) {
    /** @type {any} */
    const line = runStage(flow, stage, issue, extra);
    lines.push(line);
    if (line.end !== "wait" || line.request === undefined) {
      return lines;
    }
    const task = runTask(flow, stage, line.request, { issue });
    lines.push(task);
    const saved = savedState(readWorld(flow.ghDir), issue).stage;
    if (!["next", "wait"].includes(task.end) || saved !== stage) {
      return lines;
    }
  }
  return lines;
}

/**
 * Starts a job through the installed caller in the run folder `run`, with
 * `extra` launcher arguments such as a task request, and waits for it.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {string} run
 * @param {string} stage
 * @param {readonly string[]} [extra]
 * @returns {Promise<{ launch: any, line: any }>} its receipt line and the job's own
 */
async function callerJob(flow, run, stage, extra = []) {
  const deadline = performance.now() + RUN_MS;
  const result = spawnSync(
    process.execPath,
    [
      path.join(flow.root, "caller-jobs.mjs"),
      "start",
      "--run",
      run,
      "--config",
      flow.config,
      "--issue",
      String(ISSUE),
      "--branch",
      `agent/issue-${ISSUE}`,
      "--stage",
      stage,
      "--lane",
      "flow-caller",
      ...extra,
    ],
    { env: flow.env, encoding: "utf8", timeout: RUN_MS, killSignal: "SIGKILL" },
  );
  if (result.status !== 0) {
    throw new Error(`caller exited ${result.status}: ${result.stderr}`);
  }
  const launch = JSON.parse(result.stdout);
  const { pid, receipt } = CALLER_LAUNCH.parse(launch);
  flow.pids.push(pid);
  endsWithTest(() => killGroup(pid));
  await untilExited([pid], deadline);
  const stdout = fs.readFileSync(path.join(receipt, "stdout.log"), "utf8");
  if (stdout.trim() === "") {
    throw new Error(
      `job has no result: ${fs.readFileSync(path.join(receipt, "stderr.log"), "utf8")}`,
    );
  }
  return { launch, line: JOB_RESULT.parse(JSON.parse(stdout)) };
}

/**
 * The installed caller's status of `run`: one report per job it started.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @param {string} run
 * @returns {any[]}
 */
function callerStatus(flow, run) {
  const result = spawnSync(
    process.execPath,
    [path.join(flow.root, "caller-jobs.mjs"), "status", "--run", run],
    { env: flow.env, encoding: "utf8", timeout: RUN_MS },
  );
  if (result.status !== 0) {
    throw new Error(`caller status exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Runs the installed caller and waits for the actual guarded stage job's result.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {string} stage
 * @returns {Promise<import("zod").infer<typeof JOB_RESULT>>}
 */
async function runCallerStage(flow, stage) {
  const run = fs.mkdtempSync(path.join(flow.tmp, "caller-"));
  fs.writeFileSync(
    path.join(run, "run.json"),
    JSON.stringify({ maxJobs: 1, maxAttempts: 1 }),
  );
  return (await callerJob(flow, run, stage)).line;
}

/**
 * Ticks until a tick starts no job, giving every stage started, in order.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {number} [limit] the most ticks that may start a job
 * @returns {Promise<string[]>}
 */
async function stagesUntilIdle(flow, limit = MAX_TICKS) {
  if (limit === 0) {
    return [];
  }
  const { started } = await tick(flow);
  if (started.length === 0) {
    return [];
  }
  return [...started, ...(await stagesUntilIdle(flow, limit - 1))];
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @returns {string} */
function jobLog(flow) {
  const file = path.join(flow.root, "runs", SLUG, `issue-${ISSUE}`, "job.log");
  if (!fs.existsSync(file)) {
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * Kills each job a tick started that still runs, with its process group.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 */
function stopJobs(flow) {
  for (const pid of flow.pids.filter(isLive)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
  }
}

export {
  callerJob,
  callerStatus,
  jobLog,
  runCallerStage,
  runStage,
  runTask,
  runThroughTasks,
  stagesUntilIdle,
  stopJobs,
  tick,
};
