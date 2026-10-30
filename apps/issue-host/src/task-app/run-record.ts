// A task run's local run record, `runs/SLUG/issue-N/task-runs/ID/run.json`
// under the pipeline root, for the workflow dashboard. Only a run that won
// its claim has one. The record is rewritten whole and atomically on every
// change. It is an observation, never authority: nothing reads it to
// decide an effect, and a write that fails is reported on stderr while the
// run goes on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { ROOT } from "../host-paths.ts";

const TIME = z.iso.datetime();

const TASK_RUN = z.strictObject({
  kind: z.literal("task-run"),
  version: z.literal(1),
  id: z.uuid(),
  task: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  workItem: z.strictObject({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
    number: z.number().int().positive(),
  }),
  account: z.string().min(1),
  // The `labeled` event of the start the run took and the `unlabeled`
  // event of its claim.
  claim: z.strictObject({
    start: z.number().int().positive().nullable(),
    removal: z.number().int().positive(),
  }),
  process: z.strictObject({
    pid: z.int().positive(),
    host: z.string().min(1),
  }),
  state: z.enum(["running", "ended"]),
  step: z.enum(["mark", "work", "unmark"]),
  outcome: z.enum(["succeeded", "failed", "stopped"]).nullable(),
  reason: z.string().nullable(),
  startedAt: TIME,
  endedAt: TIME.nullable(),
});

type TaskRunRecord = z.infer<typeof TASK_RUN>;
type Step = TaskRunRecord["step"];

interface RunRecord {
  step: (step: Step) => void;
  end: (
    outcome: NonNullable<TaskRunRecord["outcome"]>,
    reason: string | null,
  ) => void;
}

function taskRunFile(repo: string, issue: number, id: string): string {
  return path.join(
    ROOT,
    "runs",
    repo.replace("/", "__"),
    `issue-${issue}`,
    "task-runs",
    id,
    "run.json",
  );
}

function write(file: string, value: TaskRunRecord): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temp, file);
  } catch (error: unknown) {
    fs.rmSync(temp, { force: true });
    process.stderr.write(`task app: cannot write ${file}: ${String(error)}\n`);
  }
}

// Starts the record of run `id`, which won `claim`, at its Mark step.
function startRunRecord(run: {
  id: string;
  task: string;
  repo: string;
  issue: number;
  account: string;
  claim: TaskRunRecord["claim"];
}): RunRecord {
  const file = taskRunFile(run.repo, run.issue, run.id);
  let now: TaskRunRecord = {
    kind: "task-run",
    version: 1,
    id: run.id,
    task: run.task,
    workItem: { repo: run.repo, number: run.issue },
    account: run.account,
    claim: run.claim,
    process: { pid: process.pid, host: os.hostname() },
    state: "running",
    step: "mark",
    outcome: null,
    reason: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  write(file, now);
  return {
    step: (step: Step): void => {
      now = { ...now, step };
      write(file, now);
    },
    end: (
      outcome: NonNullable<TaskRunRecord["outcome"]>,
      reason: string | null,
    ): void => {
      now = {
        ...now,
        state: "ended",
        outcome,
        reason,
        endedAt: new Date().toISOString(),
      };
      write(file, now);
    },
  };
}

export type { RunRecord, Step, TaskRunRecord };
export { startRunRecord, TASK_RUN, taskRunFile };
