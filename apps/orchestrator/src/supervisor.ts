// Supervise independent launchers; only launchers own discovery and task work.
import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";
import { childEnvironment } from "@ecosystem/task-runtime/child-env";
import { checkOrchestrator } from "./config.ts";

interface Launch {
  launcher: string;
  config: string;
  installRoot: string;
  hiddenVariables: readonly string[];
}
interface Event {
  kind: "started" | "output" | "exited" | "error" | "draining";
  buddy: string;
  pid?: number | undefined;
  stream?: "stdout" | "stderr";
  line?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}
interface Supervision {
  start: (launch: Launch) => ChildProcess;
  report: (event: Event) => void;
}
interface Ended {
  kind: "stopped";
  failed: string[];
}

function startLauncher(launch: Launch): ChildProcess {
  // The launcher resolves task programs from the root the fleet was checked against.
  const env: Record<string, string> = {
    ...childEnvironment(process.env),
    ...Object.fromEntries([["ECOSYSTEM_INSTALL_ROOT", launch.installRoot]]),
  };
  for (const variable of launch.hiddenVariables) {
    delete env[variable];
  }
  return spawn(process.execPath, [launch.launcher, "--config", launch.config], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function reportEvent(event: Event): void {
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
  );
}

// All configuration is checked against the release at `installRoot`, which
// each launcher then uses, before the first start. A process-start error
// drains previously started children and rejects. Runtime exits never restart
// a buddy or interrupt its healthy siblings. Abort stops discovery and drains.
async function runOrchestrator(
  file: string,
  installRoot: string,
  stop: AbortSignal,
  supervision: Supervision = { start: startLauncher, report: reportEvent },
): Promise<Ended> {
  const fleet = checkOrchestrator(file, installRoot);
  const live = new Map<ChildProcess, { buddy: string; ended: Promise<void> }>();
  const failed = new Set<string>();
  let draining = false;
  const signalled = new WeakSet<ChildProcess>();

  function stopChild(child: ChildProcess): void {
    if (child.pid !== undefined && !signalled.has(child)) {
      signalled.add(child);
      child.kill("SIGTERM");
    }
  }

  function drain(): void {
    if (draining) {
      return;
    }
    draining = true;
    for (const [child, { buddy }] of live) {
      supervision.report({ kind: "draining", buddy });
      stopChild(child);
    }
  }

  async function start(config: string, buddy: string): Promise<void> {
    const child = supervision.start({
      config,
      installRoot: fleet.installRoot,
      launcher: fleet.launcher,
      hiddenVariables: fleet.hiddenVariables,
    });
    for (const [stream, readable] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ] as const) {
      if (readable !== null) {
        const lines = createInterface({ input: readable });
        lines.on("line", (line: string) =>
          supervision.report({ kind: "output", buddy, stream, line }),
        );
      }
    }
    const ended = new Promise<void>((resolve) => {
      child.on("error", (error: Error) => {
        failed.add(buddy);
        supervision.report({ kind: "error", buddy, line: error.message });
      });
      child.once("close", (code, signal) => {
        live.delete(child);
        if (code !== 0 || !draining) {
          failed.add(buddy);
        }
        supervision.report({ kind: "exited", buddy, code, signal });
        resolve();
      });
    });
    live.set(child, { buddy, ended });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        supervision.report({ kind: "started", buddy, pid: child.pid });
        // An abort during process creation also stops this new launcher.
        if (draining || stop.aborted) {
          stopChild(child);
        }
        resolve();
      });
    });
  }

  stop.addEventListener("abort", drain, { once: true });
  try {
    await Promise.all(
      fleet.buddies.map(({ file: config, checked }) => {
        if (stop.aborted) {
          drain();
          return Promise.resolve();
        }
        return start(config, checked.buddy);
      }),
    );
    await Promise.all([...live.values()].map(({ ended }) => ended));
    return { kind: "stopped", failed: [...failed] };
  } catch (error: unknown) {
    drain();
    await Promise.all([...live.values()].map(({ ended }) => ended));
    throw error;
  } finally {
    stop.removeEventListener("abort", drain);
  }
}

export type { Ended, Event, Launch, Supervision };
export { runOrchestrator, startLauncher };
