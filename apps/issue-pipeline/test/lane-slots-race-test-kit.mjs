// @ts-check
// Retain IPC and lifecycle events even when the caller has not started waiting.
import { fork } from "node:child_process";
import { z } from "zod";
import { endsWithTest, waitFor } from "./bounded-test-kit.mjs";

const CHILD = new URL("./lane-slots-child-test-kit.mjs", import.meta.url);
const STDERR_LIMIT = 8192;
const READY = z.object({ ready: z.literal(true) });
const REPLY = z.object({
  slot: z.string().optional(),
  error: z.string().optional(),
  pruned: z.boolean().optional(),
});
/** @typedef {"claim" | "crash" | "prune" | "pending"} Mode */
/**
 * @typedef {object} ChildState
 * @property {boolean} ready
 * @property {boolean} replied
 * @property {boolean} closed
 * @property {boolean} disconnected
 * @property {string} stderr
 * @property {string} failure
 * @property {unknown} reply
 */

/** @param {string} config @param {number} issue @param {Mode} [mode] */
async function prepared(config, issue, mode = "claim") {
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
    /** @type {unknown} */
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
    start() {
      child.send({ start: true });
    },
    async result() {
      await progress("reply", () => state.replied, true);
      await progress("exit", () => state.closed);
      if (child.exitCode !== 0) {
        throw diagnostic("result");
      }
      return REPLY.parse(state.reply);
    },
    async crashed() {
      await progress("expected crash", () => state.closed);
      return child.exitCode;
    },
  };
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {ChildState} state
 * @param {number} issue
 * @param {Mode} mode
 */
function watch(child, state, issue, mode) {
  /** @param {string} phase @returns {Error} */
  function diagnostic(phase) {
    return new Error(
      `slot child ${phase}; mode=${mode}; issue=${issue}; code=${String(child.exitCode)}; signal=${String(child.signalCode)}; ${state.failure}; stderr: ${state.stderr}`,
    );
  }
  /** @param {string} phase @param {() => boolean} done @param {boolean} [needsConnection] */
  async function progress(phase, done, needsConnection = false) {
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

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {ChildState} state
 * @returns {void}
 */
function observe(child, state) {
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
