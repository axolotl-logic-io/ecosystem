#!/usr/bin/env node
// The orchestrator (#234): a long-lived process that starts stage jobs as
// the open issues need them and as their files allow.
//
//   node orchestrate.mjs --config <path> [--once]
//
// Each tick it reads the queue, starts the jobs the scheduler chose as
// detached `job.mjs` processes (src/orchestrator/tick.ts) and logs every
// decision to runs/<slug>/orchestrator.log. Without --once it ticks every
// orchestratorIntervalSeconds until SIGTERM or SIGINT, and a tick that throws
// is reported on stderr and retried at the next interval. With --once it runs
// one tick and exits 0, or 1 when the tick throws. Bad arguments or a config
// loadConfig refuses exit 1, naming the problem.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { steerJob } from "./job/control-protocol.ts";
import type { ProcessExit } from "./job/raw-results.ts";
import { orchestratorArgsOf } from "./orchestrator/args.ts";
import type { AgentRunOptions } from "./orchestrator/escalation-consult.ts";
import type { TickDeps } from "./orchestrator/tick.ts";
import { tick } from "./orchestrator/tick.ts";
import { ROOT } from "./pipeline-root.ts";

const MS_PER_SECOND = 1000;
// The escalation agent's output can be long: pi's JSON mode prints every
// event of its session.
const AGENT_OUTPUT_BYTES = 67_108_864; // 64 MiB
const INTERVAL = z.looseObject({
  orchestratorIntervalSeconds: z.number().positive(),
});

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function spawnJob(argv: readonly string[], log: string): number {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, "a");
  try {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "job.mjs"), ...argv],
      { detached: true, stdio: ["ignore", out, out] },
    );
    child.on("error", (error: Error): void => {
      process.stderr.write(`orchestrate: job.mjs: ${error.message}\n`);
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error(`could not start job.mjs ${argv.join(" ")}`);
    }
    return child.pid;
  } finally {
    fs.closeSync(out);
  }
}

// Steers a silent session; a steer pi refuses is reported on stderr.
function steerSession(socket: string, key: string, message: string): void {
  steerJob(socket, key, message).then(
    (error: string | null): void => {
      if (error !== null) {
        process.stderr.write(`orchestrate: steer ${key}: ${error}\n`);
      }
    },
    (error: unknown): void => {
      process.stderr.write(`orchestrate: steer ${key}: ${messageOf(error)}\n`);
    },
  );
}

// Asks job `pid` to stop; one already gone is left alone.
function terminateJob(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error: unknown) {
    process.stderr.write(`orchestrate: SIGTERM ${pid}: ${messageOf(error)}\n`);
  }
}

// Runs the escalation agent's pi to its end or its timeout (#282).
function runAgent(
  argv: readonly string[],
  options: AgentRunOptions,
): ProcessExit {
  const result = spawnSync("pi", argv, {
    encoding: "utf8",
    timeout: options.timeoutMs,
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: AGENT_OUTPUT_BYTES,
  });
  const timedOut =
    result.error !== undefined &&
    "code" in result.error &&
    result.error.code === "ETIMEDOUT";
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut,
  };
}

// Runs one tick; false when it threw, which it reports on stderr.
function tickOnce(cfg: Config, deps: TickDeps): boolean {
  try {
    tick(cfg, deps);
    return true;
  } catch (error: unknown) {
    process.stderr.write(`orchestrate: tick failed: ${messageOf(error)}\n`);
    return false;
  }
}

// Ticks every orchestratorIntervalSeconds until SIGTERM or SIGINT, which
// cancel the next tick; the process then ends once the running one has.
function loop(cfg: Config, deps: TickDeps): void {
  const { orchestratorIntervalSeconds } = INTERVAL.parse(cfg);
  let timer: NodeJS.Timeout | undefined;
  function run(): void {
    tickOnce(cfg, deps);
    timer = setTimeout(run, orchestratorIntervalSeconds * MS_PER_SECOND);
  }
  function stop(): void {
    clearTimeout(timer);
  }
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  run();
}

function main(argv: readonly string[]): number {
  let cfg: Config;
  let configPath: string;
  let once = false;
  try {
    const args = orchestratorArgsOf(argv);
    configPath = args.config;
    once = args.once === true;
    cfg = loadConfig(configPath);
  } catch (error: unknown) {
    process.stderr.write(`orchestrate: ${messageOf(error)}\n`);
    return 1;
  }
  const deps: TickDeps = {
    configPath,
    now: () => new Date(),
    spawn: spawnJob,
    steer: steerSession,
    terminate: terminateJob,
    runAgent,
  };
  if (once) {
    return Number(!tickOnce(cfg, deps));
  }
  loop(cfg, deps);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
