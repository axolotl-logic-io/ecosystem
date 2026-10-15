// The end-of-sweep cleanup (#174): every sweep, with or without an issue,
// asks ops to free the worktrees of issues that have closed. The sweep's own
// issue is skipped. A failed cleanup is reported in the summary, never thrown.

import type { CleanupLog, OpLaunch } from "./types.ts";

// It may run several teardowns, so it gets 30 minutes.
const CLEANUP_MINUTES = 30;

// The cleanup request, skipping the sweep's own issue, if it has one.
function cleanupLaunch(item: { n: number } | null): OpLaunch {
  let skip: number | null = null;
  if (item !== null) {
    skip = item.n;
  }
  return {
    kind: "op",
    name: "cleanup",
    op: "cleanup",
    payload: { skip },
    minutes: CLEANUP_MINUTES,
  };
}

// The cleanup's parsed ops reply as the summary's log.
function cleanupLog(reply: Readonly<Record<string, unknown>>): CleanupLog {
  const { ok, worktrees, error } = reply;
  if (ok === true) {
    let list: readonly unknown[] = [];
    if (Array.isArray(worktrees)) {
      list = worktrees;
    }
    return { worktrees: list, error: null };
  }
  let reason = "cleanup failed";
  if (typeof error === "string" && error !== "") {
    reason = error;
  }
  return { worktrees: [], error: reason };
}

export { cleanupLaunch, cleanupLog };
