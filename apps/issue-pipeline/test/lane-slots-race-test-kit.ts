// Retain IPC and lifecycle events even when the caller has not started waiting.

import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";
import { z } from "zod";
import { endsWithTest, waitFor } from "./bounded-test-kit.ts";

const CHILD = new URL("./lane-slots-child-test-kit.ts", import.meta.url);
const STDERR_LIMIT = 8192;
const READY = z.object({ ready: z.literal(true) });
const REPLY = z.object({
  slot: z.string().optional(),
  error: z.string().optional(),
  pruned: z.boolean().optional(),
});
type Mode = "claim" | "crash" | "prune" | "pending";
interface ChildState {
  ready: boolean;
  replied: boolean;
  closed: boolean;
  disconnected: boolean;
  stderr: string;
  failure: string;
  reply: unknown;
}

async function prepared(
  config: string,
  issue: number,
  mode: Mode = "claim",
): Promise<{
  start: () => void;
  result: () => Promise<{
    slot?: string | undefined;
    error?: string | undefined;
    pruned?: boolean | undefined;
  }>;
  crashed: () => Promise<number | null>;
}> {
  const child = fork(CHILD, [config, mode, String(issue)], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const state = {
    ready: false,
    replied: false,
    closed: false,
    disconnected: false,
    stderr: "",
    failure: "",
    reply: undefined,
  };
  const closed = new Promise((resolve) => {
    child.once("close", () => {
      state.closed = true;
      resolve(undefined);
    });
  });
  observe(child, state);
  endsWithTest(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  });
  const { progress, diagnostic } = watch(child, state, issue, mode);
  await progress("readiness", () => state.ready, true);
  return {
    start(): void {
      child.send({ start: true });
    },
    async result(): Promise<{
      slot?: string | undefined;
      error?: string | undefined;
      pruned?: boolean | undefined;
    }> {
      await progress("reply", () => state.replied, true);
      await progress("exit", () => state.closed);
      if (child.exitCode !== 0) {
        throw diagnostic("result");
      }
      return REPLY.parse(state.reply);
    },
    async crashed(): Promise<number | null> {
      await progress("expected crash", () => state.closed);
      return child.exitCode;
    },
  };
}

function watch(
  child: ChildProcess,
  state: ChildState,
  issue: number,
  mode: Mode,
): {
  progress: (
    phase: string,
    done: () => boolean,
    needsConnection?: boolean,
  ) => Promise<void>;
  diagnostic: (phase: string) => Error;
} {
  function diagnostic(phase: string): Error {
    return new Error(
      `slot child ${phase}; mode=${mode}; issue=${issue}; code=${String(child.exitCode)}; signal=${String(child.signalCode)}; ${state.failure}; stderr: ${state.stderr}`,
    );
  }
  async function progress(
    phase: string,
    done: () => boolean,
    needsConnection = false,
  ): Promise<void> {
    try {
      await waitFor(
        `slot child ${phase}`,
        () =>
          done() ||
          state.closed ||
          state.failure !== "" ||
          (needsConnection && state.disconnected),
      );
      if (!done() || state.failure !== "") {
        // Close follows exit/disconnect and drains the original loader stderr.
        await waitFor("slot child close", () => state.closed);
        throw diagnostic(phase);
      }
    } catch (error) {
      throw new Error(diagnostic(phase).message, { cause: error });
    }
  }
  return { progress, diagnostic };
}

function observe(child: ChildProcess, state: ChildState): void {
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    state.stderr = (state.stderr + String(chunk)).slice(-STDERR_LIMIT);
  });
  child.on("error", (error) => {
    state.failure = String(error);
  });
  child.once("disconnect", () => {
    state.disconnected = true;
  });
  child.on("message", (message) => {
    if (!state.ready) {
      const ready = READY.safeParse(message);
      if (!ready.success) {
        state.failure = String(ready.error);
        return;
      }
      state.ready = true;
      return;
    }
    state.reply = message;
    state.replied = true;
  });
}

export { prepared };
