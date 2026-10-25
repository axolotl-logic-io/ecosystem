// Assignment mode in the full-flow world (#119, #120): the repo config opted
// in with its grantor, the grantor's (un)assignments on the fake GitHub, a
// stage job started for an assignment beside the test, and what the issue's
// GitHub record and origin keep.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Launch } from "../scripts/caller-jobs/run-folder.ts";
import type { Decision } from "../scripts/sweep/plan.ts";
import type { JobLine } from "../src/job/role-end.ts";
import { alive, endsWithTest, killGroup, waitFor } from "./bounded-test-kit.ts";
import { ghAccountCalls } from "./fake-pipeline-flow-gh.ts";
import { readWorld } from "./fake-pipeline-flow-gh-world.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { ISSUE } from "./pipeline-flow-test-kit.ts";

const GRANTOR = "axolotl-logic";
const HIPPY = "dev-bot";
const LAWD = "bot";
const WRITE_FLAG = /^(?:-X|--method|-f|-F|--field|--raw-field|--input)$/u;
const READ_SUBCOMMANDS = new Set(["list", "view", "checks"]);
// A decision line the sweep prints: the sweep it came from, and the decision.
interface SweepLine extends Decision {
  sweep: number;
}

// A job the sweep started: its launch.json, and its line (null when it
// printed none).
interface StartedJob {
  launch: Launch;
  line: JobLine | null;
}

// A stage job's bound (pipeline-flow-run-test-kit.ts's RUN_MS).
const JOB_MS = 120_000;

// Opts the flow's repo config in to assignment mode, with `grantor`.
function optIn(flow: Flow, grantor: string = GRANTOR): void {
  const config = JSON.parse(fs.readFileSync(flow.config, "utf8"));
  config.assignments = { grantor };
  fs.writeFileSync(flow.config, JSON.stringify(config));
}

// Every gh call that writes to GitHub, by either account, from the
// `from`th call on.
function ghWrites(flow: Flow, from = 0): string[][] {
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

// The issue's comments the landing account wrote, in order.
function pipelineComments(flow: Flow, issue: number = ISSUE): string[] {
  return readWorld(flow.ghDir)
    .comments.filter((each) => each.issue === issue && each.login === LAWD)
    .map(({ body }) => body);
}

// Starts the `stage` job for an assignment beside the test, with `extra`
// arguments; resolves to its exit code, its line (null when it printed
// none) and its stderr.
function startAssigned(
  flow: Flow,
  stage: string,
  {
    issue = ISSUE,
    extra = [],
  }: { issue?: number; extra?: readonly string[] } = {},
): Promise<{ code: number | null; line: JobLine | null; stderr: string }> {
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
      let line: JobLine | null = null;
      if (out.trim() !== "") {
        line = JSON.parse(out);
      }
      resolve({ code, line, stderr });
    });
  });
}

// A new run folder for the sweep, with run.json's `limits`.
function runFolder(flow: Flow, limits: Record<string, unknown>): string {
  const run = fs.mkdtempSync(path.join(flow.tmp, "sweep-run-"));
  fs.writeFileSync(
    path.join(run, "run.json"),
    JSON.stringify({ maxAttempts: 2, ...limits }),
  );
  return run;
}

// Runs one installed sweep over the flow's repo in `run`, with `extra`
// arguments; gives each decision line it printed.
function sweep(
  flow: Flow,
  run: string,
  extra: readonly string[] = [],
): SweepLine[] {
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

// Waits for every job `decisions` started to end; gives each one's launch
// and its line.
async function startedJobs(
  flow: Flow,
  decisions: readonly SweepLine[],
): Promise<StartedJob[]> {
  const started = decisions
    .map(({ start }) => start)
    .filter((start) => start !== undefined)
    .map(({ receipt }): { receipt: string; launch: Launch } => ({
      receipt,
      launch: JSON.parse(
        fs.readFileSync(path.join(receipt, "launch.json"), "utf8"),
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
    let line: JobLine | null = null;
    if (out.trim() !== "") {
      line = JSON.parse(out);
    }
    return { launch, line };
  });
}

export type { StartedJob, SweepLine };
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
