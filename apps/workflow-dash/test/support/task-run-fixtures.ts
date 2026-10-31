// Task run records for tests, written as the task framework writes them:
// one whole `run.json` per run under the runs folder, with its sessions'
// transcripts beside it.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import type { TaskRunRecord } from "../../task-runs.ts";

const repo = "fixture-org/fixture-repo";
const slug = "fixture-org__fixture-repo";

function taskRun(
  id: string,
  issue: number,
  overrides: Partial<TaskRunRecord> = {},
): TaskRunRecord {
  return {
    kind: "task-run",
    version: 1,
    id,
    task: "gherkin",
    workItem: { repo, number: issue },
    account: "fixture-account",
    claim: { start: 100, removal: 101 },
    process: { pid: process.pid, host: hostname() },
    state: "running",
    step: "work",
    outcome: null,
    reason: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    ...overrides,
  };
}
function taskRunPath(runs: string, issue: number, id: string): string {
  return join(runs, slug, `issue-${issue}`, "task-runs", id, "run.json");
}
async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function writeRecord(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}
/** A live Node process running `script` in `folder`; the caller kills it. */
async function nodeProcess(
  folder: string,
  script: string,
): Promise<ChildProcess & { pid: number }> {
  const path = join(folder, script);
  await writeText(path, "setInterval(() => undefined, 1000);\n");
  const child = spawn(process.execPath, [path], { stdio: "ignore" });
  await once(child, "spawn");
  const { pid } = child;
  if (pid === undefined) {
    throw new Error("fixture process has no pid");
  }
  return Object.assign(child, { pid });
}

export {
  nodeProcess,
  repo,
  slug,
  taskRun,
  taskRunPath,
  writeRecord,
  writeText,
};
