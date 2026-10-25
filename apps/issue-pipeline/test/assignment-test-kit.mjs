// @ts-check
// Assignment mode in the full-flow world (#119, #120): the repo config opted
// in with its grantor, the grantor's (un)assignments on the fake GitHub, a
// stage job started for an assignment beside the test, and what the issue's
// GitHub record and origin keep.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { endsWithTest, killGroup } from "./bounded-test-kit.mjs";
import { ghAccountCalls } from "./fake-pipeline-flow-gh.mjs";
import { readWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { ISSUE } from "./pipeline-flow-test-kit.mjs";

/** @typedef {import("./pipeline-flow-test-kit.mjs").Flow} Flow */

const GRANTOR = "axolotl-logic";
const HIPPY = "dev-bot";
const LAWD = "bot";
const WRITE_FLAG = /^(?:-X|--method|-f|-F|--field|--raw-field|--input)$/u;
const READ_SUBCOMMANDS = new Set(["list", "view", "checks"]);

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

export {
  GRANTOR,
  ghWrites,
  HIPPY,
  LAWD,
  optIn,
  pipelineComments,
  startAssigned,
};
