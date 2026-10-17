// One ops.mjs child of the stage job, run to its end: it starts in a process
// group of its own, gets its request on stdin, and is stopped, its whole
// group, once its time is up (commands-leave-no-processes, #371). While it
// runs, the job holds a handle to it, so that a stop can end its group too.

import { spawn } from "node:child_process";
import process from "node:process";
import { endGroup } from "../process-group.ts";
import { STOP_GRACE_MS } from "./control.ts";
import type { ProcessExit } from "./raw-results.ts";

// A running ops child: its launch key, its pid, which is also its process
// group's id (null when it never started), and its end.
interface OpsProcess {
  key: string;
  pid: number | null;
  // Resolves once the child has exited.
  exited: Promise<void>;
}

// An ops command to run for launch `key`: its arguments, stdin and time
// limit, and the hook told of it once it starts.
interface OpsRun {
  key: string;
  args: readonly string[];
  input: string;
  timeoutMs: number;
  started: (ops: OpsProcess) => void;
}

// Runs ops.mjs, writing its input to stdin. Once its time is up, its group
// gets SIGTERM, and SIGKILL if it hasn't exited within STOP_GRACE_MS. A
// command that can't start ends with code null and the reason on stderr.
function runOps(run: OpsRun): Promise<ProcessExit> {
  const { args, input, timeoutMs } = run;
  const program = process.execPath;
  return new Promise((resolve: (exit: ProcessExit) => void): void => {
    const exit: ProcessExit = {
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
    };
    const child = spawn(program, args, { stdio: "pipe", detached: true });
    const pid = child.pid ?? null;
    const exited = new Promise<void>((done: () => void): void => {
      child.on("exit", (): void => done());
      child.on("close", (): void => done());
    });
    run.started({ key: run.key, pid, exited });
    const timer = setTimeout((): void => {
      exit.timedOut = true;
      if (pid !== null) {
        endGroup(pid, exited, STOP_GRACE_MS).catch(() => null);
      }
    }, timeoutMs);
    function noteError(error: Error): void {
      exit.stderr += `${program}: ${error.message}\n`;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string): void => {
      exit.stdout += chunk;
    });
    child.stderr.on("data", (chunk: string): void => {
      exit.stderr += chunk;
    });
    child.stdin.on("error", noteError);
    child.on("error", noteError);
    child.on("close", (code: number | null): void => {
      clearTimeout(timer);
      resolve({ ...exit, code });
    });
    child.stdin.end(input);
  });
}

export type { OpsProcess };
export { runOps };
