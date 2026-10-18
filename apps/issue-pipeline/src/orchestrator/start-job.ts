// How the orchestrator's tick starts a stage job: the job's argv, with the
// random id it makes for the job (`--job-id`), which its usage records,
// context log and pushes carry too; the detached process; and the record of
// each start, `runs/<slug>/starts.json`, which keeps a spawned job live
// until it writes its job.json. Every job claims in the orchestrator's lane.
// A restart is a fresh job at the stage the dead job was at: no job is
// given `--resume`, and none starts on another issue's branch. A merge job
// gets the merge queue (`--merge-queue`), which its merge-order check reads.
// This module alone knows the start records' file; a missing or malformed
// one reads as no starts, and each save rewrites it atomically.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { ROOT } from "../pipeline-root.ts";
import { STAGES } from "../stages.ts";
import { ORCHESTRATOR_LANE } from "./issue-plan.ts";
import type { Decision } from "./schedule.ts";

const STARTS_FILE = "starts.json";
const JSON_INDENT = 2;
// The latest start of each issue's job: its stage, process, id and time.
const START_RECORD = z.object({
  issue: z.number(),
  stage: z.enum(STAGES),
  pid: z.number(),
  job: z.string(),
  at: z.string(),
});
const START_RECORDS = z.array(START_RECORD);

type StartRecord = z.infer<typeof START_RECORD>;
type Start = Extract<Decision, { action: "started" }>;

// What starting a job takes: the repo config's path, as the jobs are given
// it, and the spawn of a detached job.mjs, which gives its pid.
interface Starter {
  cfg: Config;
  configPath: string;
  spawn: (argv: readonly string[], log: string) => number;
}

function startsFileOf(cfg: Config): string {
  return path.join(ROOT, "runs", cfg.slug, STARTS_FILE);
}

function readStarts(cfg: Config): StartRecord[] {
  try {
    const text = fs.readFileSync(startsFileOf(cfg), "utf8");
    const parsed = START_RECORDS.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // A missing or unreadable file holds no starts.
  }
  return [];
}

// Saves the latest start of each issue in `open`.
function saveStarts(
  cfg: Config,
  starts: readonly StartRecord[],
  open: ReadonlySet<number>,
): void {
  const latest = new Map(starts.map((start) => [start.issue, start]));
  const kept = [...latest.values()].filter(({ issue }) => open.has(issue));
  const file = startsFileOf(cfg);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(kept, null, JSON_INDENT)}\n`);
  fs.renameSync(temp, file);
}

function jobArgv(configPath: string, start: Start, job: string): string[] {
  const argv = [
    "--config",
    configPath,
    "--issue",
    String(start.issue),
    "--stage",
    start.stage,
    "--lane",
    ORCHESTRATOR_LANE,
    "--job-id",
    job,
  ];
  if (start.mergeQueue !== null) {
    argv.push("--merge-queue", start.mergeQueue.join(","));
  }
  return argv;
}

// Spawns the job `start` decided and gives its start record.
function startJob(starter: Starter, start: Start): StartRecord {
  const job = randomUUID();
  const argv = jobArgv(starter.configPath, start, job);
  const { cfg } = starter;
  const pid = starter.spawn(argv, paths.jobLog(cfg, start.issue));
  const { issue, stage, at } = start;
  return { issue, stage, pid, job, at };
}

export type { Starter, StartRecord };
export { readStarts, saveStarts, startJob };
