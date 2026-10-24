import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import type { WorkflowData } from "./source-records.ts";

const exec = promisify(execFile);
const processReadTimeout = 3000;
const commandReadBytes = 8192;
const processListBytes = 1_048_576;
type ProcessCheck = (pid: number | null | undefined) => Promise<boolean | null>;

async function pidWorkflowRun(
  pid: number | null | undefined,
): Promise<boolean | null> {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    process.kill(pid, 0);
    const result = await exec("ps", ["-o", "command=", "-p", String(pid)], {
      timeout: processReadTimeout,
      maxBuffer: commandReadBytes,
    });
    return result.stdout.includes("job.mjs");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    return null;
  }
}
async function live(
  run: Pick<WorkflowData, "pid" | "outcome">,
  check: ProcessCheck = pidWorkflowRun,
): Promise<boolean | null> {
  if (run.outcome === undefined) {
    return null;
  }
  if (run.outcome !== null) {
    return false;
  }
  try {
    return await check(run.pid);
  } catch {
    return null;
  }
}
async function processList(): Promise<string> {
  try {
    return (
      await exec("ps", ["-axo", "pid=,command="], {
        timeout: processReadTimeout,
        maxBuffer: processListBytes,
      })
    ).stdout;
  } catch {
    return "";
  }
}

export type { ProcessCheck };
export { exec, live, pidWorkflowRun, processList };
