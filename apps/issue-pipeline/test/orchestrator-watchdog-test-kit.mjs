// @ts-check
// The watchdog tests' ticks (#235): one tick over recorded job.json files
// with every spawn, steer and SIGTERM recorded, and the log lines it wrote.
import fs from "node:fs";
import { z } from "zod";
import {
  CONFIG,
  cfg,
  deadPid,
  MINUTE_MS,
  NOW,
  openWith,
  runFile,
} from "./orchestrator-world-test-kit.mjs";

const { tick } = await import("../src/orchestrator/tick.ts");

/** @import { OpenIssue } from "./orchestrator-world-test-kit.mjs" */
/** @import { Config } from "../src/config.ts" */

const LOG_LINE = z.object({
  issue: z.number(),
  stage: z.string(),
  action: z.string(),
  reason: z.string(),
});

/**
 * One tick at `minutes` after NOW over `issues`, with every spawn, steer and
 * SIGTERM recorded, under `config` (the kit's by default). Spawned jobs die
 * at once, as a crashing job would, unless `spawnPid` gives the live pid they
 * run as.
 * @param {readonly OpenIssue[]} issues
 * @param {number} [minutes]
 * @param {{ config?: Config, spawnPid?: number }} [options]
 */
function tickOver(issues, minutes = 0, options = {}) {
  const { config = cfg, spawnPid } = options;
  openWith(issues);
  /** @type {string[][]} */
  const spawned = [];
  /** @type {string[][]} */
  const steered = [];
  /** @type {number[]} */
  const terminated = [];
  tick(config, {
    configPath: CONFIG,
    now: () => new Date(NOW.getTime() + minutes * MINUTE_MS),
    spawn: (argv) => {
      spawned.push([...argv]);
      return spawnPid ?? deadPid();
    },
    steer: (socket, key, message) => steered.push([socket, key, message]),
    terminate: (pid) => terminated.push(pid),
  });
  return { spawned, steered, terminated };
}

/** @param {number} issue @returns {z.infer<typeof LOG_LINE>[]} */
function loggedFor(issue) {
  return fs
    .readFileSync(runFile("orchestrator.log"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => LOG_LINE.parse(JSON.parse(line)))
    .filter((line) => line.issue === issue);
}

export { loggedFor, tickOver };
