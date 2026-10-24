// Lawd's read-only Integration (#185; `sync-is-a-task`): it checks revision R
// on the exact target T only when R already contains T, in a detached
// checkout of R that no branch or push can reach. It never commits, rebases,
// pushes or writes a PR; its only GitHub writes are the landing account's
// attempt and result (#183). The Integration task job
// (roles/integration/integration.ts) calls it since #186.
//
//   target not at T, or R missing T → sync-needed, no attempt
//   branch not at R                 → hold, no attempt
//   no current passed Hardening     → hardening-needed, no attempt
//   checks fail                     → failed, back to the Developer
//   tracked files changed           → failed and retained, back to the Developer
//   T, R, inputs or policy moved    → failed, its result is no longer current
//   checks pass, nothing moved      → passed, on to Security

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { fetchIn, gitIn, remoteHead } from "../git-state.ts";
import { withCloneLock } from "../locks.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest, run } from "../process.ts";
import { BINDING, RUN_ID, requestedBinding } from "../task-result-records.ts";
import { statusIn, taskRecords, unsettledAttempts } from "../task-results.ts";
import type { Check } from "./checks.ts";
import { changedFiles, runChecks } from "./checks.ts";
import type { RevisionBinding } from "./task-gate.ts";
import {
  assertCurrentRevision,
  contains,
  isRevisionBinding,
} from "./task-gate.ts";
import { appendResult, startAttempt } from "./task-results.ts";

const MAX_SUMMARY = 300;

const REQUEST = z.looseObject({
  number: z.number().int().positive(),
  binding: BINDING,
  run: z.strictObject({ id: RUN_ID, previous: RUN_ID.nullable() }),
});

type Route =
  | "sync-needed"
  | "hardening-needed"
  | "hold"
  | "developer"
  | "security";

interface IntegrationReply {
  route: Route;
  reason: string;
  verdict?: "passed" | "failed";
  checks?: { id: string; pass: boolean }[];
  retained?: string;
}

interface IntegrationRun {
  cfg: Config;
  number: number;
  binding: RevisionBinding;
  run: string;
}

function refuse(reason: string): never {
  throw new OpsError(`Integration refused: ${reason}`);
}

// Why R can't be checked on T right now, as the route that fixes it, read
// fresh: the target's tip, the branch's head and R's ancestry.
function notReady(
  cfg: Config,
  number: number,
  binding: RevisionBinding,
): IntegrationReply | undefined {
  const wt = paths.worktree(cfg, number);
  fetchIn(cfg, wt, cfg.baseBranch, paths.branch(cfg, number));
  const tip = gitIn(wt, ["rev-parse", `origin/${cfg.baseBranch}`]).trim();
  const { code } = binding.revision;
  const target = binding.target.commit;
  if (tip !== target) {
    return {
      route: "sync-needed",
      reason: `the target is at ${tip}, not ${target}`,
    };
  }
  if (remoteHead(cfg, number) !== code) {
    return {
      route: "hold",
      reason: `the branch is no longer at revision ${code}`,
    };
  }
  if (!contains(wt, code, target)) {
    return {
      route: "sync-needed",
      reason: `revision ${code} does not contain ${target}`,
    };
  }
  return undefined;
}

function recorded(
  task: IntegrationRun,
  verdict: "passed" | "failed",
  reply: IntegrationReply,
): IntegrationReply {
  appendResult(task.cfg, task.number, {
    binding: task.binding,
    run: { id: task.run },
    verdict,
    receipt: {
      summary: reply.reason.slice(0, MAX_SUMMARY),
      evidence: {
        route: reply.route,
        checks: reply.checks ?? [],
        retained: reply.retained ?? null,
      },
    },
  });
  return { ...reply, verdict };
}

// R's checks in a fresh detached checkout under the run folder. Tracked
// changes the checks leave are evidence: their patch is saved and the
// checkout kept; otherwise it is removed.
function checkedAt(task: IntegrationRun): {
  checks: Check[];
  pass: boolean;
  retained: string | null;
} {
  const { cfg, number, binding } = task;
  const wt = paths.worktree(cfg, number);
  fs.mkdirSync(paths.runDir(cfg, number), { recursive: true });
  const parent = fs.mkdtempSync(
    path.join(paths.runDir(cfg, number), "integration-"),
  );
  const dir = path.join(parent, "repo");
  withCloneLock(cfg, () =>
    gitIn(wt, ["worktree", "add", "--detach", dir, binding.revision.code]),
  );
  const changed = changedFiles(
    dir,
    binding.target.commit,
    binding.revision.code,
  );
  const reply = runChecks(cfg, number, {
    dir,
    sha: binding.revision.code,
    changed,
    keepTracked: true,
  });
  const tracked = gitIn(dir, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]).trim();
  if (tracked !== "") {
    const patch = path.join(parent, "tracked.patch");
    fs.writeFileSync(patch, gitIn(dir, ["diff", "--binary", "HEAD"]));
    return { checks: reply.checks, pass: false, retained: parent };
  }
  withCloneLock(cfg, () => {
    run("git", ["-C", wt, "worktree", "remove", "--force", dir], {
      allowFail: true,
    });
    run("git", ["-C", wt, "worktree", "prune"], { allowFail: true });
  });
  fs.rmSync(parent, { recursive: true, force: true });
  return { checks: reply.checks, pass: reply.pass, retained: null };
}

function integrationTask(cfg: Config, request: unknown): IntegrationReply {
  const req = parseRequest(REQUEST, "integration-task", request);
  const binding = requestedBinding(cfg, req.number, req.binding);
  if (binding.task !== "Integration" || !isRevisionBinding(binding)) {
    refuse("the binding is not an Integration binding of a revision");
  }
  const rows = taskRecords(cfg, req.number, listComments(cfg, req.number));
  if (unsettledAttempts(rows, "Land").length > 0) {
    refuse(
      "a Land attempt is armed or uncertain; reconcile it read-only first",
    );
  }
  assertCurrentRevision(cfg, req.number, binding, refuse);
  const blocked = notReady(cfg, req.number, binding);
  if (blocked !== undefined) {
    return blocked;
  }
  const hardening = statusIn(rows, { ...binding, task: "Hardening" });
  if (hardening.status !== "passed") {
    return {
      route: "hardening-needed",
      reason: `Hardening of this exact revision and target is ${hardening.status}`,
    };
  }
  const own = statusIn(rows, binding);
  if (own.status === "passed") {
    return {
      route: "security",
      verdict: "passed",
      reason: "already passed for this binding",
    };
  }
  startAttempt(cfg, req.number, binding, req.run);
  const task: IntegrationRun = {
    cfg,
    number: req.number,
    binding,
    run: req.run.id,
  };
  const { checks, pass, retained } = checkedAt(task);
  const exits = checks.map(({ id, pass: ok }) => ({ id, pass: ok }));
  if (retained !== null) {
    return recorded(task, "failed", {
      route: "developer",
      reason: `the checks changed tracked files; the checkout and its patch are retained in ${retained}`,
      checks: exits,
      retained,
    });
  }
  let moved: string | undefined;
  try {
    assertCurrentRevision(cfg, req.number, binding, refuse);
    moved = notReady(cfg, req.number, binding)?.reason;
  } catch (error) {
    if (!(error instanceof OpsError)) {
      throw error;
    }
    moved = error.message;
  }
  if (moved !== undefined) {
    return recorded(task, "failed", {
      route: "sync-needed",
      reason: `moved during the checks: ${moved}`,
      checks: exits,
    });
  }
  if (!pass) {
    const failing = exits
      .filter((check) => !check.pass)
      .map((check) => check.id);
    return recorded(task, "failed", {
      route: "developer",
      reason: `checks failed on ${binding.revision.code}: ${failing.join(", ")}`,
      checks: exits,
    });
  }
  return recorded(task, "passed", {
    route: "security",
    reason: `every check passed on ${binding.revision.code} at ${binding.target.commit}`,
    checks: exits,
  });
}

const integrationTaskOps: Readonly<
  Record<string, (cfg: Config, request: unknown) => IntegrationReply>
> = { "integration-task": integrationTask };

export { integrationTaskOps };
