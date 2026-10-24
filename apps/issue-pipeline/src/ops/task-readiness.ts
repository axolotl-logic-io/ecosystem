// The task-readiness op (#186; `bindings-and-ready-tasks`): which
// revision-bound task is ready next for the issue, read fresh and read only.
// It reads revision R (the branch head, today's trusted inputs and policy),
// the configured target's tip T, whether R contains T, and the status of each
// task of the chain for exactly R on T, then names the first task whose
// result isn't a current pass, with its binding, or a hold. A role routes on
// the answer and a caller only relays it, so a buddy could ask the same
// question later. It writes nothing.
//
//   a Land attempt armed or uncertain    → hold
//   no Implementation current for the
//   requirements (implementation-ready)  → Implementation
//   R doesn't contain T                  → Sync (R, T)
//   Hardening, Integration, Security     → the first not passed, in order
//   all three passed                     → Land, then Completion once landed
//
// Sync comes first when it's needed: its R′ needs fresh Hardening anyway, so
// hardening a revision that misses T would be work Sync throws away.

import { z } from "zod";
import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { fetchIn, gitIn, remoteHead } from "../git-state.ts";
import { trustedInputsHash, writeIssueContext } from "../issue-context.ts";
import { parseRequest } from "../process.ts";
import { configPolicyDigest } from "../project-policy.ts";
import type { Binding, Row, TaskStatus } from "../task-result-records.ts";
import { TaskResultsHold } from "../task-result-records.ts";
import { statusIn, taskRecords, unsettledAttempts } from "../task-results.ts";
import {
  implementationNext,
  implementedRevision,
} from "./implementation-ready.ts";
import type { RevisionBinding } from "./task-gate.ts";
import { contains } from "./task-gate.ts";

const REQUEST = z.looseObject({ number: z.number().int().positive() });

// The tasks a revision passes through after Sync, in chain order
// (`sequential-tasks`).
const CHECKS = ["Hardening", "Integration", "Security"] as const;

type ChainTask =
  | "Implementation"
  | "Sync"
  | (typeof CHECKS)[number]
  | "Land"
  | "Completion";

interface ReadyTask {
  task: ChainTask;
  binding: Binding;
  // The binding's own status: missing for new work, unknown for a run to
  // reconcile, refused for a subject that stays refused.
  status: TaskStatus["status"];
}

type ReadinessReply = {
  revision: RevisionBinding["revision"] | null;
  target: RevisionBinding["target"];
  contains: boolean;
  // The revision the current Implementation result produced, or null.
  implemented: string | null;
} & ({ next: ReadyTask; hold: null } | { next: null; hold: string });

// The status of `task` for `base`'s revision and target.
function statusOf(
  rows: readonly Row[],
  base: RevisionBinding,
  task: ChainTask,
): TaskStatus {
  return statusIn(rows, { ...base, task });
}

// The first task of the chain that isn't a current pass, or why none may run.
function nextIn(
  rows: readonly Row[],
  base: RevisionBinding,
  synced: boolean,
): { next: ReadyTask; hold: null } | { next: null; hold: string } {
  const land = unsettledAttempts(rows, "Land");
  if (land.length > 0) {
    const hold = `Land run ${land[0]?.run.id} is armed or uncertain; reconcile it read-only first`;
    return { next: null, hold };
  }
  const implementation = implementationNext(rows, base);
  if (implementation !== null && "hold" in implementation) {
    return { next: null, hold: implementation.hold };
  }
  if (implementation !== null) {
    return { ...implementation, hold: null };
  }
  const order: ChainTask[] = [...CHECKS, "Land"];
  if (!synced) {
    order.unshift("Sync");
  }
  for (const task of order) {
    const { status } = statusOf(rows, base, task);
    if (status === "exhausted") {
      return {
        next: null,
        hold: `${task} has used its attempts for this exact revision and target`,
      };
    }
    if (status !== "passed") {
      return { next: { task, binding: { ...base, task }, status }, hold: null };
    }
  }
  return {
    next: {
      task: "Completion",
      binding: { ...base, task: "Land" },
      status: "passed",
    },
    hold: null,
  };
}

function taskReadiness(cfg: Config, request: unknown): ReadinessReply {
  const req = parseRequest(REQUEST, "task-readiness", request);
  const wt = paths.worktree(cfg, req.number);
  fetchIn(cfg, wt, cfg.baseBranch, paths.branch(cfg, req.number));
  const tip = gitIn(wt, ["rev-parse", `origin/${cfg.baseBranch}`]).trim();
  const target = { branch: cfg.baseBranch, commit: tip };
  const code = remoteHead(cfg, req.number);
  if (code === null) {
    return {
      revision: null,
      target,
      contains: false,
      implemented: null,
      next: null,
      hold: "the issue's branch has no head to bind",
    };
  }
  const context = writeIssueContext(cfg, req.number);
  const revision = {
    code,
    inputs: trustedInputsHash(cfg, context.issue, context.comments),
    policy: configPolicyDigest(cfg),
  };
  const synced = contains(wt, code, tip);
  const base: RevisionBinding = {
    repo: cfg.repo,
    workItem: req.number,
    task: "Sync",
    revision,
    target,
  };
  let rows: Row[];
  try {
    rows = taskRecords(cfg, req.number, listComments(cfg, req.number));
  } catch (error) {
    if (error instanceof TaskResultsHold) {
      return {
        revision,
        target,
        contains: synced,
        implemented: null,
        next: null,
        hold: error.message,
      };
    }
    throw error;
  }
  return {
    revision,
    target,
    contains: synced,
    implemented: implementedRevision(rows, base),
    ...nextIn(rows, base, synced),
  };
}

const taskReadinessOps: Readonly<
  Record<string, (cfg: Config, request: unknown) => ReadinessReply>
> = { "task-readiness": taskReadiness };

export type { ReadinessReply };
export { taskReadinessOps };
