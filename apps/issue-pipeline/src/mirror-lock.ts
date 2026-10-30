// Serialize fetches and Git metadata updates in the shared local mirror.
import fs from "node:fs";
import path from "node:path";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { sleepMs } from "./process.ts";

// How long an op waits for a lock: 5 minutes.
const LOCK_WAIT_MS = 300_000;
// A lock older than 10 minutes is from a dead op.
const STALE_LOCK_MS = 600_000;
const SHORTEST_RETRY_MS = 250;
const RETRY_SPREAD_MS = 500;

// How many times this process holds each lock it holds.
const lockDepth = new Map<string, number>();

function isAlreadyThere(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

// Waits for the lock directory and makes it, or throws once the wait is over.
function acquire(lock: string): void {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      return;
    } catch (error) {
      if (!isAlreadyThere(error)) {
        throw error;
      }
      const made = fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
      if (Date.now() - (made ?? Date.now()) > STALE_LOCK_MS) {
        fs.rmSync(lock, { force: true, recursive: true });
      } else if (Date.now() > deadline) {
        throw new OpsError(`timed out waiting for ${lock}`, { cause: error });
      } else {
        sleepMs(SHORTEST_RETRY_MS + Math.random() * RETRY_SPREAD_MS);
      }
    }
  }
}

// Runs `fn` holding the lock at path `lock`. mkdir is atomic, so the directory
// is the lock. Reentrant within one process.
function withLock<T>(lock: string, fn: () => T): T {
  const depth = lockDepth.get(lock) ?? 0;
  if (depth > 0) {
    lockDepth.set(lock, depth + 1);
    try {
      return fn();
    } finally {
      lockDepth.set(lock, depth);
    }
  }
  acquire(lock);
  lockDepth.set(lock, 1);
  try {
    return fn();
  } finally {
    lockDepth.delete(lock);
    fs.rmSync(lock, { force: true, recursive: true });
  }
}

function withCloneLock<T>(cfg: Config, fn: () => T): T {
  return withLock(`${paths.clone(cfg)}.lock`, fn);
}

export { withCloneLock };
