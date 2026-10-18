// The cleanup op, run at the end of every sweep: frees the worktree, local
// branches, wiki checkout and teardown resources of each closed issue whose
// work is all on GitHub. Anything in doubt is kept, with the reason.

import { z } from "zod";
import { issueWorktrees, removeWorktree, unsavedWork } from "../checkouts.ts";
import { liveClaims } from "../claims.ts";
import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import { issueState } from "../github.ts";
import { withCloneLock } from "../locks.ts";
import { parseRequest } from "../process.ts";
import { readState } from "../saved-state.ts";
import { unsavedWiki } from "../wiki.ts";

// `skip` is the sweep's own issue, which its lane may still be using.
const CLEANUP_REQUEST = z.looseObject({ skip: z.number().int().nullish() });
const PR_NUMBER = z.number().int().positive();

type WorktreeOutcome =
  | { issue: number; outcome: "removed" }
  | { issue: number; outcome: "kept"; why: string };

interface CleanupReply {
  worktrees: WorktreeOutcome[];
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Why issue n's worktree must stay, or null when it may go. The checks run
// in order and stop at the first that fails.
function keepReason(
  cfg: Config,
  n: number,
  skip: number | null,
): string | null {
  if (n === skip) {
    return "this sweep's issue";
  }
  const state = issueState(cfg, n);
  if (state !== "closed") {
    return `the issue is ${state ?? "in an unknown state on GitHub"}`;
  }
  const comments = listComments(cfg, n);
  const lanes = liveClaims(cfg, comments).map((claim) => claim.lane);
  if (lanes.length > 0) {
    return `a live claim is held by lane ${lanes.join(", ")}`;
  }
  const { state: stored } = readState(cfg, n, comments);
  const pr = PR_NUMBER.safeParse(stored?.pr).data ?? null;
  return unsavedWork(cfg, n, pr) ?? unsavedWiki(cfg, n);
}

// Checks issue n and removes its worktree, holding the clone lock for this
// issue only. An error keeps the worktree.
function cleanIssue(
  cfg: Config,
  n: number,
  skip: number | null,
): WorktreeOutcome {
  try {
    return withCloneLock(cfg, (): WorktreeOutcome => {
      const why = keepReason(cfg, n, skip);
      if (why !== null) {
        return { issue: n, outcome: "kept", why };
      }
      removeWorktree(cfg, n);
      return { issue: n, outcome: "removed" };
    });
  } catch (error) {
    return { issue: n, outcome: "kept", why: errorText(error) };
  }
}

function cleanup(cfg: Config, request: unknown): CleanupReply {
  const { skip } = parseRequest(CLEANUP_REQUEST, "cleanup", request);
  const worktrees = issueWorktrees(cfg).map((n) =>
    cleanIssue(cfg, n, skip ?? null),
  );
  return { worktrees };
}

export type { CleanupReply, WorktreeOutcome };
export { cleanup };
