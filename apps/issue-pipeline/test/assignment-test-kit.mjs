// @ts-check
// Assignment mode in the full-flow world (#119, #120): the repo config opted
// in with its grantor, the grantor's (un)assignments on the fake GitHub, a
// stage job started for an assignment beside the test, and what the issue's
// GitHub record and origin keep.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  alive,
  endsWithTest,
  killGroup,
  waitFor,
} from "./bounded-test-kit.mjs";
import { ghAccountCalls } from "./fake-pipeline-flow-gh.mjs";
import { readWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { ISSUE } from "./pipeline-flow-test-kit.mjs";

/** @typedef {import("./pipeline-flow-test-kit.mjs").Flow} Flow */

const GRANTOR = "axolotl-logic";
const HIPPY = "dev-bot";
const LAWD = "bot";
const WRITE_FLAG = /^(?:-X|--method|-f|-F|--field|--raw-field|--input)$/u;
const READ_SUBCOMMANDS = new Set(["list", "view", "checks"]);
// A stage job's bound (pipeline-flow-run-test-kit.mjs's RUN_MS).
const JOB_MS = 120_000;

/**
 * Opts the flow's repo config in to assignment mode, with `grantor`.
 * @param {Flow} flow @param {string} [grantor]
 */
function optIn(flow, grantor = GRANTOR) {
  const config = JSON.parse(fs.readFileSync(flow.config, "utf8"));
  config.assignments = { grantor };
  fs.writeFileSync(flow.config, JSON.stringify(config));
}

/**
 * Every gh call that writes to GitHub, by either account, from the
 * `from`th call on.
 * @param {Flow} flow @param {number} [from]
 * @returns {string[][]}
 */
function ghWrites(flow, from = 0) {
  return ghAccountCalls(flow.ghDir)
    .slice(from)
    .map(({ args }) => args)
    .filter((args) => {
      if (args[0] === "api") {
        return args.some((arg) => WRITE_FLAG.test(arg));
      }
      return !READ_SUBCOMMANDS.has(String(args[1]));
    });
}

/**
 * The issue's comments the landing account wrote, in order.
 * @param {Flow} flow @param {number} [issue] @returns {string[]}
 */
function pipelineComments(flow, issue = ISSUE) {
  return readWorld(flow.ghDir)
    .comments.filter((each) => each.issue === issue && each.login === LAWD)
    .map(({ body }) => body);
}

/**
 * Starts the `stage` job for an assignment beside the test, with `extra`
 * arguments; resolves to its exit code, its line (null when it printed
 * none) and its stderr.
 * @param {Flow} flow @param {string} stage
 * @param {{ issue?: number, extra?: readonly string[] }} [options]
 * @returns {Promise<{ code: number | null, line: any, stderr: string }>}
 */
function startAssigned(flow, stage, { issue = ISSUE, extra = [] } = {}) {
  const args = [
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
    "assigned",
    "--assignment",
    ...extra,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: flow.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    endsWithTest(() => {
      if (child.exitCode === null && child.pid !== undefined) {
        killGroup(child.pid);
      }
    });
    let out = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      let line = null;
      if (out.trim() !== "") {
        line = JSON.parse(out);
      }
      resolve({ code, line, stderr });
    });
  });
}

/**
 * A new run folder for the sweep, with run.json's `limits`.
 * @param {Flow} flow @param {Record<string, unknown>} limits @returns {string}
 */
function runFolder(flow, limits) {
  const run = fs.mkdtempSync(path.join(flow.tmp, "sweep-run-"));
  fs.writeFileSync(
    path.join(run, "run.json"),
    JSON.stringify({ maxAttempts: 2, ...limits }),
  );
  return run;
}

/**
 * Runs one installed sweep over the flow's repo in `run`, with `extra`
 * arguments; gives each decision line it printed.
 * @param {Flow} flow @param {string} run @param {readonly string[]} [extra]
 * @returns {any[]}
 */
function sweep(flow, run, extra = []) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(flow.root, "sweep.mjs"),
      "--run",
      run,
      "--config",
      flow.config,
      "--lane",
      "sweep",
      ...extra,
    ],
    { env: flow.env, encoding: "utf8", timeout: JOB_MS, killSignal: "SIGKILL" },
  );
  if (result.status !== 0) {
    throw new Error(`sweep exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Waits for every job `decisions` started to end; gives each one's launch
 * and its line.
 * @param {Flow} flow @param {readonly any[]} decisions
 * @returns {Promise<{ launch: any, line: any }[]>}
 */
async function startedJobs(flow, decisions) {
  const started = decisions
    .filter(({ start }) => start !== undefined)
    .map(({ start }) => ({
      receipt: start.receipt,
      launch: JSON.parse(
        fs.readFileSync(path.join(start.receipt, "launch.json"), "utf8"),
      ),
    }));
  for (const { launch } of started) {
    flow.pids.push(launch.pid);
    endsWithTest(() => killGroup(launch.pid));
  }
  await waitFor(
    "the sweep's jobs to end",
    () => started.every(({ launch }) => !alive(launch.pid)),
    JOB_MS,
  );
  return started.map(({ receipt, launch }) => {
    const out = fs.readFileSync(path.join(receipt, "stdout.log"), "utf8");
    let line = null;
    if (out.trim() !== "") {
      line = JSON.parse(out);
    }
    return { launch, line };
  });
}

export {
  GRANTOR,
  ghWrites,
  HIPPY,
  LAWD,
  optIn,
  pipelineComments,
  runFolder,
  startAssigned,
  startedJobs,
  sweep,
};
