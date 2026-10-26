import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const processReadTimeout = 3000;
const commandReadBytes = 8192;
const processListBytes = 1_048_576;
type ProcessInspection =
  | { state: "running"; command: string; startedAt: number | null }
  | { state: "absent" }
  | { state: "unknown"; reason: string };
const processLine =
  /^\s*(?<start>\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}) +(?<command>.*)$/su;

/**
 * A signal-0 existence probe, then the process's start time and command
 * line. Denied or failed inspection is unknown, never absent; nothing is
 * signalled.
 */
async function inspectProcess(
  pid: number | null | undefined,
): Promise<ProcessInspection> {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { state: "unknown", reason: "no valid pid recorded" };
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return { state: "absent" };
    }
    return { state: "unknown", reason: "process inspection denied" };
  }
  try {
    const result = await exec(
      "ps",
      ["-o", "lstart=", "-o", "command=", "-p", String(pid)],
      { timeout: processReadTimeout, maxBuffer: commandReadBytes },
    );
    const line = processLine.exec(result.stdout.trim())?.groups;
    if (line?.start === undefined || line.command === undefined) {
      return { state: "unknown", reason: "process command unreadable" };
    }
    const parsed = Date.parse(line.start);
    let startedAt: number | null = parsed;
    if (Number.isNaN(parsed)) {
      startedAt = null;
    }
    return { state: "running", command: line.command, startedAt };
  } catch {
    return { state: "unknown", reason: "process command unreadable" };
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

export type { ProcessInspection };
export { exec, inspectProcess, processList };
