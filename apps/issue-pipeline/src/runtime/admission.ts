// Admission of one action: a task's readiness for a qualified signal
// becomes an action only when, freshly and in this order, the work item is
// not stopping or stopped, the trusted buddy and repository configuration
// still authorize the task (Land needs both permissions.land grants), the
// work item's stop latch reads clear, the causal signal still qualifies,
// the action wins fenced issue-execution ownership under its own new UUID,
// and its model-session reservation is granted from the repository's
// shared pool at the trusted cap. A loser or a full pool waits; anything
// unreadable or contradictory holds. Whatever admission took before it
// refused is given back when that is certain, and held otherwise.
//
// Test slots and the target's integration turn are not reserved here: the
// checkout slot and the task's own Land turn (taken by Land's beginAction)
// already reserve them, and a second reservation would be a duplicate pool.

import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { INVOCATION_BINDING } from "../coordination-record-schema.ts";
import type {
  Binding,
  QualifiedSignal,
  TaskDefinition,
  WorkItemRef,
} from "../domain.ts";
import { issueExecution, withExecution } from "../execution.ts";
import type { SignalScope } from "../signals/inbox.ts";
import { requalify, stopLatch } from "../signals/inbox.ts";
import { previousAction } from "../tasks/index.ts";
import type { AdmittedAction } from "./action.ts";
import type {
  BuddyEnvelope,
  BuddyRepository,
  LoadedBuddy,
} from "./buddy-config.ts";
import { bindBuddyAuthorization } from "./buddy-config.ts";
import type { BuddyRunId } from "./ids.ts";
import { newActionRunId } from "./ids.ts";
import type { ReservationHandle } from "./reservations.ts";
import { reserveModelSession } from "./reservations.ts";
import type { StopControl } from "./stop.ts";

type Admission =
  | { state: "admitted"; action: AdmittedAction }
  | { state: "waiting" | "held" | "stopped"; reason: string };

// One ready or recoverable task binding, for the signal that showed it.
interface Candidate {
  buddy: LoadedBuddy;
  // The repository config's file, and the config as this poll loaded it.
  repository: BuddyRepository;
  task: TaskDefinition;
  signal: QualifiedSignal;
  binding: Binding;
  mode: "act" | "recover";
  buddyRun: BuddyRunId;
  stop: StopControl;
  scope: SignalScope;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// The stable lane of the buddy's work on one work item: the same for every
// action of this buddy on it, never a capacity slot.
function laneOf(buddy: LoadedBuddy, item: WorkItemRef): string {
  return `buddy:${buddy.config.name}:${item.repo}:${item.number}`;
}

// Gives back the issue's execution, when nothing was done under it; says
// what still holds it otherwise.
function giveBack(cfg: Config, issue: number, why: string): Admission {
  try {
    issueExecution(cfg, issue).release();
    return { state: "waiting", reason: why };
  } catch (error: unknown) {
    return {
      state: "held",
      reason: `${why}; execution release unconfirmed: ${messageOf(error)}`,
    };
  }
}

// Reserves the action's model session, when its task uses one and it acts.
async function reserveFor(
  candidate: Candidate,
  cfg: Config,
  execution: AdmittedAction["execution"],
): Promise<
  | { reservation: ReservationHandle | null }
  | { refused: string; state: "waiting" | "held" }
> {
  if (
    candidate.mode === "recover" ||
    !candidate.task.resources.includes("model-session")
  ) {
    return { reservation: null };
  }
  const reserved = await reserveModelSession(
    cfg,
    execution,
    candidate.repository.modelSessions,
  );
  if (reserved.state === "reserved") {
    return { reservation: reserved.reservation };
  }
  return { refused: reserved.reason, state: reserved.state };
}

// Admits `candidate`, or says why it waits, holds or is stopped.
async function admit(candidate: Candidate): Promise<Admission> {
  const { buddy, repository, task, signal, stop, scope } = candidate;
  const { workItem } = candidate.binding;
  const issue = workItem.number;
  const stopped = stop.stopOf(workItem);
  if (stopped !== null) {
    return { state: "stopped", reason: stopped.reason };
  }
  const envelope: BuddyEnvelope = {
    config: buddy.file,
    run: candidate.buddyRun,
    task: task.id,
    authorizationDigest: repository.authorizationDigest,
  };
  let authorized: Config;
  try {
    authorized = bindBuddyAuthorization(
      repository.cfg,
      repository.file,
      envelope,
    );
  } catch (error: unknown) {
    return { state: "held", reason: messageOf(error) };
  }
  const latch = await stopLatch(authorized, issue);
  if (latch.state === "latched") {
    stop.stopWorkItem(workItem, latch.reason);
    return { state: "stopped", reason: latch.reason };
  }
  if (latch.state === "unknown") {
    return { state: "held", reason: `stop latch unknown: ${latch.reason}` };
  }
  const current = await requalify(authorized, scope, signal);
  if (current.status !== "qualified") {
    return {
      state: "held",
      reason: `signal ${signal.id} ${current.status}: ${current.reason}`,
    };
  }
  let previous: string | null;
  try {
    previous = await previousAction(authorized, candidate.binding);
  } catch (error: unknown) {
    return {
      state: "held",
      reason: `previous action unreadable: ${messageOf(error)}`,
    };
  }
  const id = newActionRunId();
  let cfg: Config;
  let execution: AdmittedAction["execution"];
  try {
    execution = INVOCATION_BINDING.parse({
      instance: id,
      lane: laneOf(buddy, workItem),
      issue,
      branch: paths.branch(authorized, issue),
      repo: authorized.repo,
      base: authorized.baseBranch,
    });
    cfg = withExecution(authorized, execution);
  } catch (error: unknown) {
    return { state: "held", reason: messageOf(error) };
  }
  try {
    const guard = issueExecution(cfg, issue);
    if (!guard.tryAcquire()) {
      return {
        state: "waiting",
        reason: `another invocation owns #${issue}`,
      };
    }
  } catch (error: unknown) {
    return {
      state: "held",
      reason: `issue execution unconfirmed: ${messageOf(error)}`,
    };
  }
  const reserved = await reserveFor(candidate, cfg, execution);
  if ("refused" in reserved) {
    const back = giveBack(cfg, issue, reserved.refused);
    if (back.state === "waiting") {
      return { state: reserved.state, reason: reserved.refused };
    }
    return back;
  }
  return {
    state: "admitted",
    action: {
      id,
      cfg,
      execution,
      envelope,
      binding: candidate.binding,
      signal,
      cause: { signal: signal.id, recordId: signal.recordId },
      previous,
      reservation: reserved.reservation,
      mode: candidate.mode,
    },
  };
}

export type { Admission, Candidate };
export { admit };
