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
import { ISSUE, SLUG } from "./pipeline-flow-kit.mjs";

// A tick's orchestrator, and each job it starts, is given this long to end.
// The slowest flow job measured took about 5 s.
const RUN_MS = 60_000;
const POLL_MS = 50;
// A flow ends within this many ticks, or the test fails.
const MAX_TICKS = 12;

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
 * @param {import("./pipeline-flow-kit.mjs").Flow} flow
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
  if (Date.now() > deadline) {
    throw new Error(`jobs ${pids.join(", ")} ran past ${RUN_MS} ms`);
  }
  await delay(POLL_MS);
  await untilExited(pids, deadline);
}

/**
 * Runs one orchestrator tick, then waits for every job it started to exit.
 * @param {import("./pipeline-flow-kit.mjs").Flow} flow
 * @returns {Promise<{ started: string[], log: any[] }>} the stages it
 * started and the tick's orchestrator log lines
 */
async function tick(flow) {
  const logFile = path.join(flow.root, "runs", SLUG, "orchestrator.log");
  const before = jsonLines(logFile).length;
  const known = new Set(flow.pids);
  const orchestrate = path.join(flow.root, "orchestrate.mjs");
  const result = spawnSync(
    process.execPath,
    [
      orchestrate,
      "--config",
      flow.config,
      "--brain-path",
      flow.brain,
      "--once",
    ],
    { env: flow.env, encoding: "utf8", timeout: RUN_MS, killSignal: "SIGKILL" },
  );
  if (result.status !== 0) {
    throw new Error(`orchestrate exited ${result.status}: ${result.stderr}`);
  }
  const fresh = startsOf(flow).filter(({ pid }) => !known.has(pid));
  const pids = fresh.map(({ pid }) => pid);
  flow.pids.push(...pids);
  await untilExited(pids, Date.now() + RUN_MS);
  return {
    started: fresh.map(({ stage }) => stage),
    log: jsonLines(logFile).slice(before),
  };
}

/**
 * Runs exactly the caller's assigned issue/stage/branch; no discovery or sweep.
 * @param {import("./pipeline-flow-kit.mjs").Flow} flow
 * @param {string} stage
 * @returns {{ issue: number, stage: string, end: string }}
 */
function runStage(flow, stage) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(flow.root, "job.mjs"),
      "--config",
      flow.config,
      "--issue",
      String(ISSUE),
      "--branch",
      `agent/issue-${ISSUE}`,
      "--brain-path",
      flow.brain,
      "--stage",
      stage,
      "--lane",
      "flow-caller",
    ],
    { env: flow.env, encoding: "utf8", timeout: RUN_MS, killSignal: "SIGKILL" },
  );
  if (result.status !== 0) {
    throw new Error(`job exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Ticks until a tick starts no job, giving every stage started, in order.
 * @param {import("./pipeline-flow-kit.mjs").Flow} flow
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

/** @param {import("./pipeline-flow-kit.mjs").Flow} flow @returns {string} */
function jobLog(flow) {
  const file = path.join(flow.root, "runs", SLUG, `issue-${ISSUE}`, "job.log");
  if (!fs.existsSync(file)) {
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * Kills each job a tick started that still runs, with its process group.
 * @param {import("./pipeline-flow-kit.mjs").Flow} flow
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

export { jobLog, runStage, stagesUntilIdle, stopJobs, tick };
