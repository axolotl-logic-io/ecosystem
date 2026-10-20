import type { z } from "zod";
import { liveClaims } from "../claims.ts";
import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import { trustedInputsHash } from "../issue-context.ts";
import { OpsError } from "../ops-error.ts";
import { readWriteState } from "../saved-state.ts";
import { integrationLock, issueLock, lockHead } from "./exclusion.ts";
import type { Hub } from "./github.ts";
import { hubOf } from "./github.ts";
import type { Execution } from "./schema.ts";
import { freshScope } from "./scope.ts";
import { ISSUE } from "./signal-schema.ts";
import { developmentGrant, reviewGrant, workerOf } from "./signals.ts";

function assertInputs(
  cfg: Config,
  issue: number,
  current: z.infer<typeof ISSUE>,
): void {
  if (cfg.execution?.stage !== "author") {
    const state = readWriteState(cfg, issue);
    if (
      state.gherkin?.inputs !==
      trustedInputsHash(cfg, current, listComments(cfg, issue))
    ) {
      throw new OpsError(
        "trusted inputs changed; reauthor before further controlled mutations",
      );
    }
  }
}

function assertOwnership(cfg: Config, execution: Execution, hub: Hub): void {
  const { issue } = execution;
  if (lockHead(hub, issueLock(issue)) !== execution.token) {
    throw new OpsError("exclusive execution ownership lost");
  }
  if (
    execution.stage === "merge" &&
    (execution.turn === null ||
      lockHead(hub, integrationLock(cfg.baseBranch)) !== execution.turn)
  ) {
    throw new OpsError("serialized integration turn is missing or lost");
  }
}

function assertClaim(cfg: Config, execution: Execution): void {
  const state = readWriteState(cfg, execution.issue);
  const lane = executionLane(execution.token);
  if (
    state.stage === "done" &&
    state.merged !== null &&
    state.security?.finding === null
  ) {
    return;
  }
  if (
    state.lease?.lane !== lane ||
    !liveClaims(cfg, listComments(cfg, execution.issue)).some(
      (claim) => claim.lane === lane,
    )
  ) {
    throw new OpsError(
      "stage claim missing, expired or displaced; preserve work and reconcile",
    );
  }
}

function executionLane(token: string): string {
  return `assignment-${token}`;
}

// Rechecked at job entry, every op, writer scope and credentialed push.
// An absent/invalid grant is withdrawal even when its remover is untrusted.
// This observes revocation, not an atomic transaction with outside actors.
function assertExecution(
  config: Config,
  issue: number,
  claiming = false,
  hub: Hub = hubOf(config),
): void {
  const cfg = freshScope(config);
  if (cfg.assignment === undefined) {
    if (cfg.execution !== undefined) {
      throw new OpsError("assignment worker scope was withdrawn");
    }
    return;
  }
  const { execution } = cfg;
  if (execution === undefined || execution.issue !== issue) {
    throw new OpsError(
      "assignment mode refuses explicit dispatch without exclusive worker authority",
    );
  }
  const worker = workerOf(cfg, execution.worker);
  assertOwnership(cfg, execution, hub);
  if (!claiming) {
    assertClaim(cfg, execution);
  }
  const current = ISSUE.parse(hub.read(`issues/${issue}`));
  assertInputs(cfg, issue, current);
  if (worker.roles === "development") {
    if (!["author", "implement"].includes(execution.stage)) {
      throw new OpsError("development worker cannot execute review or merge");
    }
    developmentGrant(hub, cfg, current, worker);
  } else {
    if (!["review", "merge"].includes(execution.stage)) {
      throw new OpsError("review worker cannot execute development roles");
    }
    const state = readWriteState(cfg, issue);
    if (state.coordination?.handoff?.id !== execution.handoff) {
      throw new OpsError("review handoff ownership lost");
    }
    reviewGrant(hub, cfg, current, { state, worker });
  }
}

export { assertExecution, executionLane };
