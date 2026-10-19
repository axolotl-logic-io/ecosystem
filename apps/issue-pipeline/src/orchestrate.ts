#!/usr/bin/env node

// The orchestrator: a long-lived process, the only one that claims issues for
// its repo, that starts stage jobs (author, implement, review, merge) as the
// open issues need them.
//
//   node orchestrate.mjs --config <path> --brain-path <wiki clone> [--once]
//
// Each tick it reads the queue, starts the jobs the scheduler chose as
// detached `job.mjs` processes (src/orchestrator/tick.ts) and logs every
// decision to runs/<slug>/orchestrator.log. Without --once it ticks every
// orchestratorIntervalSeconds until SIGTERM or SIGINT, and a tick that throws
// is reported on stderr and retried at the next interval. With --once it runs
// one tick and exits 0, or 1 when the tick throws. Bad arguments or a config
// loadConfig refuses exit 1, naming the problem, before any tick.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { childEnvironment } from "./child-env.ts";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { orchestratorArgsOf } from "./orchestrator/args.ts";
import type { TickDeps } from "./orchestrator/tick.ts";
import { tick } from "./orchestrator/tick.ts";
import { ROOT } from "./pipeline-root.ts";

const MS_PER_SECOND = 1000;
// How a stage job's command line names its entry.
const JOB_ENTRY = "job.mjs";
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
      [path.join(ROOT, JOB_ENTRY), ...argv],
      {
        env: childEnvironment(process.env),
        detached: true,
        stdio: ["ignore", out, out],
      },
    );
    child.on("error", (error: Error): void => {
      process.stderr.write(`orchestrate: ${JOB_ENTRY}: ${error.message}\n`);
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error(`could not start ${JOB_ENTRY} ${argv.join(" ")}`);
    }
    return child.pid;
  } finally {
    fs.closeSync(out);
  }
}

// True while process `pid` runs a stage job: signal 0 checks it exists
// without sending, and its command line must name job.mjs, so a pid the
// system reused for another program doesn't hold or count an issue. When
// `ps` can't say, an existing process counts.
function isStageJob(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error: unknown) {
    if (
      !(error instanceof Error && "code" in error && error.code === "EPERM")
    ) {
      return false;
    }
  }
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    env: childEnvironment(process.env),
  });
  if (ps.status !== 0 || ps.error !== undefined) {
    return true;
  }
  return ps.stdout.includes(JOB_ENTRY);
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
  let args: ReturnType<typeof orchestratorArgsOf>;
  try {
    args = orchestratorArgsOf(argv);
    cfg = loadConfig(args.config);
  } catch (error: unknown) {
    process.stderr.write(`orchestrate: ${messageOf(error)}\n`);
    return 1;
  }
  const deps: TickDeps = {
    configPath: args.config,
    brainPath: args.brainPath,
    now: () => new Date(),
    spawn: spawnJob,
    alive: isStageJob,
  };
  if (args.once === true) {
    return Number(!tickOnce(cfg, deps));
  }
  loop(cfg, deps);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
