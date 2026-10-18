// @ts-check
// The watchdog tests' ticks (#235): one tick over recorded job.json files
// with every spawn, steer and SIGTERM recorded, and the log lines it wrote.
// The escalation agent's run (#282) is the test's to give; by default it
// throws, which the tick logs as the agent failing.
import fs from "node:fs";
import { z } from "zod";
import { withoutJobId } from "./orchestrator-job-id-kit.mjs";
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
/** @import { RunAgent } from "../src/orchestrator/escalation-consult.ts" */
/** @import { TickDeps } from "../src/orchestrator/tick.ts" */
/** @import { RoleName } from "../src/roles/registry.ts" */

/** @type {RunAgent} */
function noAgent() {
  throw new Error("unexpected escalation agent run");
}

const LOG_LINE = z.object({
  issue: z.number(),
  stage: z.string(),
  action: z.string(),
  reason: z.string(),
});

/**
 * One tick at `minutes` after NOW over `issues`, with every spawn (less its
 * job id), steer and SIGTERM recorded, under `config` (the kit's by default). Spawned jobs die
 * at once, as a crashing job would, unless `spawnPid` gives the live pid they
 * run as. `runAgent` runs the escalation agent's pi. `roles` are the roles
 * the orchestrator runs (#417); left out, the tick takes the config's.
 * @param {readonly OpenIssue[]} issues
 * @param {number} [minutes]
 * @param {{ config?: Config, spawnPid?: number, runAgent?: RunAgent, roles?: readonly RoleName[] }} [options]
 */
function tickOver(issues, minutes = 0, options = {}) {
  const { config = cfg, spawnPid, runAgent = noAgent, roles } = options;
  openWith(issues);
  /** @type {string[][]} */
  const spawned = [];
  /** @type {string[][]} */
  const steered = [];
  /** @type {number[]} */
  const terminated = [];
  /** @type {TickDeps} */
  const deps = {
    configPath: CONFIG,
    now: () => new Date(NOW.getTime() + minutes * MINUTE_MS),
    spawn: (argv) => {
      spawned.push(withoutJobId(argv));
      return spawnPid ?? deadPid();
    },
    steer: (socket, key, message) => steered.push([socket, key, message]),
    terminate: (pid) => terminated.push(pid),
    runAgent,
  };
  if (roles !== undefined) {
    deps.roles = roles;
  }
  const { decisions } = tick(config, deps);
  return { spawned, steered, terminated, decisions };
}

// What the ticks logged for `issue`; nothing before the first line is logged.
/** @param {number} issue @returns {z.infer<typeof LOG_LINE>[]} */
function loggedFor(issue) {
  const file = runFile("orchestrator.log");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => LOG_LINE.parse(JSON.parse(line)))
    .filter((line) => line.issue === issue);
}

export { loggedFor, tickOver };
