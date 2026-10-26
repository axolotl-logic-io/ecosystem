// One buddy run: a single activation of a buddy that runs every task loop it
// is responsible for, in every repository of its scope, one action at a
// time. Each cycle rereads the trusted configuration, polls each
// repository's qualified signals once, reads each signalled work item's task
// view once, and offers every signal to every responsible task whose sensors
// take its kind. A ready (or recoverable) binding goes through admission
// (admission.ts) and runs as an action (action.ts); after an action began,
// the cycle starts over on fresh evidence. With nothing to do the run waits
// for its poll interval or its stop. There is no global stage cursor.
//
// The run keeps its observation (`runs/buddy-runs/<id>/run.json`) current:
// a lease renewed with a fresh process observation, each loop's state, and
// its stop and outcome. A changed or unreadable trusted configuration stops
// the run, since its actions were authorized under the configuration it
// started with.

import type { Config } from "../config.ts";
import type {
  EvidenceHold,
  QualifiedSignal,
  Readiness,
  TaskDefinition,
  TaskId,
  TaskView,
} from "../domain.ts";
import type { SignalScope } from "../signals/inbox.ts";
import { pollSignals } from "../signals/inbox.ts";
import { readTaskView, TASKS } from "../tasks/index.ts";
import type { ActionSummary } from "./action.ts";
import { runAction } from "./action.ts";
import { admit } from "./admission.ts";
import type { BuddyRepository, LoadedBuddy } from "./buddy-config.ts";
import { loadBuddy } from "./buddy-config.ts";
import type { BuddyRunId } from "./ids.ts";
import { newBuddyRunId } from "./ids.ts";
import type {
  BuddyDiagnostics,
  BuddyRunObservation,
  LoopObservation,
  Observed,
} from "./observations.ts";
import {
  buddyDiagnostics,
  buddyRunFile,
  observed,
  previousBuddyRun,
  processObservation,
} from "./observations.ts";
import type { StopControl } from "./stop.ts";
import { pause } from "./stop.ts";

const MS_PER_SECOND = 1000;
const LEASE_RENEWALS = 3;

// How a buddy run ended.
interface BuddyRunEnd {
  id: BuddyRunId;
  kind: "stopped" | "failed";
  reason: string;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function now(): string {
  return new Date().toISOString();
}

function leaseOf(seconds: number): BuddyRunObservation["lease"] {
  return {
    seconds,
    expiresAt: new Date(Date.now() + seconds * MS_PER_SECOND).toISOString(),
  };
}

function digestsOf(buddy: LoadedBuddy): string {
  return JSON.stringify(
    buddy.repositories.map((repository) => [
      repository.file,
      repository.authorizationDigest,
    ]),
  );
}

function initialObservation(
  id: BuddyRunId,
  buddy: LoadedBuddy,
  startedAt: string,
): BuddyRunObservation {
  const { config } = buddy;
  const loops: LoopObservation[] = buddy.repositories.flatMap((repository) =>
    buddy.tasks.map(
      (task): LoopObservation => ({
        task,
        repo: repository.cfg.repo,
        state: "idle",
        reason: null,
        polledAt: null,
        action: null,
      }),
    ),
  );
  return {
    kind: "buddy-run",
    version: 1,
    id,
    previous: previousBuddyRun(config.name),
    buddy: {
      name: config.name,
      role: config.role,
      identity: config.identity.name,
      config: buddy.file,
    },
    tasks: [...buddy.tasks],
    scope: {
      organization: config.scope.organization,
      repositories: buddy.repositories.map((repository) => ({
        config: repository.file,
        repo: repository.cfg.repo,
        base: repository.cfg.baseBranch,
        authorization: repository.authorizationDigest,
      })),
    },
    accounts: [{ ...config.identity.account }],
    process: processObservation(startedAt),
    lease: leaseOf(config.leaseSeconds),
    state: "running",
    outcome: null,
    stop: null,
    loops,
    caps: buddy.repositories.map((repository) => ({
      repo: repository.cfg.repo,
      modelSessions: repository.modelSessions,
      testSlots: repository.cfg.laneSlots ?? null,
    })),
  };
}

// Sets loop `task` of `repo` in the observation.
function setLoop(
  cycle: Cycle,
  where: { task: TaskId; repo: string },
  change: Partial<Omit<LoopObservation, "task" | "repo">>,
): void {
  if (change.state === "held" && typeof change.reason === "string") {
    cycle.diagnostics.held(where, change.reason);
  }
  cycle.observation.update(
    (run: BuddyRunObservation): BuddyRunObservation => ({
      ...run,
      loops: run.loops.map((loop: LoopObservation): LoopObservation => {
        if (loop.task !== where.task || loop.repo !== where.repo) {
          return loop;
        }
        return { ...loop, ...change };
      }),
    }),
  );
}

// Resolves true at the first of `items`, in order, that `step` resolves true
// for, without starting the next before the last settled; false for none.
async function firstOf<T>(
  items: readonly T[],
  step: (item: T) => Promise<boolean>,
): Promise<boolean> {
  const [head, ...rest] = items;
  if (head === undefined) {
    return false;
  }
  if (await step(head)) {
    return true;
  }
  return await firstOf(rest, step);
}

// What one cycle works with.
interface Cycle {
  buddy: LoadedBuddy;
  id: BuddyRunId;
  stop: StopControl;
  scope: SignalScope;
  observation: Observed<BuddyRunObservation>;
  diagnostics: BuddyDiagnostics;
}

// The signals of `signals` grouped by work item number, in number order.
function byWorkItem(
  signals: readonly QualifiedSignal[],
): (readonly [number, QualifiedSignal[]])[] {
  const items = new Map<number, QualifiedSignal[]>();
  for (const signal of signals) {
    const list = items.get(signal.workItem.number) ?? [];
    list.push(signal);
    items.set(signal.workItem.number, list);
  }
  return [...items].sort(([a], [b]): number => a - b);
}

// The readiness of `task` for `signal`, or null when the task doesn't take
// it.
function readinessOf(
  task: TaskDefinition,
  signal: QualifiedSignal,
  view: TaskView,
): Readiness | null {
  if (!task.sensors.includes(signal.kind)) {
    return null;
  }
  return task.match(signal, view);
}

function modeOf(readiness: Readiness): "act" | "recover" {
  if (readiness.state === "recover") {
    return "recover";
  }
  return "act";
}

function loopStateOf(summary: ActionSummary): LoopObservation["state"] {
  if (summary.notAdmitted !== null) {
    return summary.notAdmitted;
  }
  if (summary.ownership === "retained") {
    return "held";
  }
  return "idle";
}

// Offers `signal` to `task`; admits and runs the binding it is ready for.
// Resolves true when an action began.
async function offerSignal(
  cycle: Cycle,
  offer: {
    repository: BuddyRepository;
    task: TaskDefinition;
    view: TaskView;
  },
  signal: QualifiedSignal,
): Promise<boolean> {
  const { repository, task, view } = offer;
  const where = { task: task.id, repo: repository.cfg.repo };
  const readiness = readinessOf(task, signal, view);
  if (readiness === null || cycle.stop.buddy.aborted) {
    return false;
  }
  if (readiness.state !== "ready" && readiness.state !== "recover") {
    setLoop(cycle, where, {
      state: readiness.state,
      reason: readiness.reason,
    });
    return false;
  }
  const admission = await admit({
    buddy: cycle.buddy,
    repository,
    task,
    signal,
    binding: readiness.binding,
    mode: modeOf(readiness),
    buddyRun: cycle.id,
    stop: cycle.stop,
    scope: cycle.scope,
  });
  if (admission.state !== "admitted") {
    setLoop(cycle, where, {
      state: admission.state,
      reason: admission.reason,
    });
    return false;
  }
  const { action } = admission;
  setLoop(cycle, where, {
    state: "acting",
    reason: null,
    action: action.id,
  });
  const summary = await runAction(action, {
    buddyRun: cycle.id,
    repository,
    task,
    stop: cycle.stop,
    scope: cycle.scope,
    stopPollSeconds: cycle.buddy.config.stopPollSeconds,
  });
  setLoop(cycle, where, {
    state: loopStateOf(summary),
    reason: summary.reason ?? summary.end.reason,
  });
  cycle.diagnostics.ended(where, summary);
  return summary.notAdmitted === null;
}

async function viewOf(cfg: Config, number: number): Promise<TaskView | string> {
  try {
    return await readTaskView(cfg, number);
  } catch (error: unknown) {
    return `#${String(number)}'s task view unreadable: ${messageOf(error)}`;
  }
}

function setAllLoops(
  cycle: Cycle,
  repo: string,
  change: Partial<Omit<LoopObservation, "task" | "repo">>,
): void {
  for (const task of cycle.buddy.tasks) {
    setLoop(cycle, { task, repo }, change);
  }
}

// Offers one work item's signals to every task loop, in task order. A held
// item, or one whose view is unreadable, gets no offer.
async function offerWorkItem(
  cycle: Cycle,
  repository: BuddyRepository,
  item: { number: number; signals: readonly QualifiedSignal[]; held: boolean },
): Promise<boolean> {
  const { cfg } = repository;
  if (item.held || cycle.stop.buddy.aborted) {
    return false;
  }
  const view = await viewOf(cfg, item.number);
  if (typeof view === "string") {
    setAllLoops(cycle, cfg.repo, { state: "held", reason: view });
    return false;
  }
  return await firstOf(
    cycle.buddy.tasks,
    (id: TaskId): Promise<boolean> =>
      firstOf(
        item.signals,
        (signal: QualifiedSignal): Promise<boolean> =>
          offerSignal(cycle, { repository, task: TASKS[id], view }, signal),
      ),
  );
}

// Polls one repository and offers its signals to every task loop. Resolves
// true when an action began.
async function pollRepository(
  cycle: Cycle,
  repository: BuddyRepository,
): Promise<boolean> {
  const { cfg } = repository;
  const inbox = await pollSignals(cfg, cycle.scope, cycle.id);
  // A hold, of the whole poll or of one work item, shows held until an
  // offer of another work item reports on the loops.
  const shown =
    inbox.holds.find((item: EvidenceHold): boolean => item.workItem === null) ??
    inbox.holds.at(0);
  let state: LoopObservation["state"] = "idle";
  if (shown !== undefined) {
    state = "held";
  }
  setAllLoops(cycle, cfg.repo, {
    polledAt: now(),
    state,
    reason: shown?.reason ?? null,
  });
  const held = new Set(
    inbox.holds.flatMap((hold: EvidenceHold): number[] => {
      if (hold.workItem === null) {
        return [];
      }
      return [hold.workItem.number];
    }),
  );
  return await firstOf(
    byWorkItem(inbox.signals),
    ([number, signals]: readonly [
      number,
      QualifiedSignal[],
    ]): Promise<boolean> =>
      offerWorkItem(cycle, repository, {
        number,
        signals,
        held: held.has(number),
      }),
  );
}

// One cycle over every repository; true when an action began.
function runCycle(cycle: Cycle): Promise<boolean> {
  return firstOf(
    cycle.buddy.repositories,
    (repository: BuddyRepository): Promise<boolean> => {
      if (cycle.stop.buddy.aborted) {
        return Promise.resolve(false);
      }
      return pollRepository(cycle, repository);
    },
  );
}

// What the run keeps across its cycles.
interface Activation {
  file: string;
  id: BuddyRunId;
  stop: StopControl;
  scope: SignalScope;
  trusted: string;
  pollSeconds: number;
  observation: Observed<BuddyRunObservation>;
  diagnostics: BuddyDiagnostics;
}

// Runs cycles until the run stops: each on a freshly reread trusted
// configuration, which stops the run when it changed or can't be read;
// with nothing begun it waits its poll interval or its stop.
async function cycles(activation: Activation): Promise<void> {
  const { file, stop } = activation;
  if (stop.buddy.aborted) {
    return;
  }
  let fresh: LoadedBuddy;
  try {
    fresh = loadBuddy(file);
  } catch (error: unknown) {
    stop.stopBuddy(`trusted configuration unreadable: ${messageOf(error)}`);
    return;
  }
  if (digestsOf(fresh) !== activation.trusted) {
    stop.stopBuddy(
      "trusted configuration changed; restart the buddy to run under it",
    );
    return;
  }
  const began = await runCycle({
    buddy: fresh,
    id: activation.id,
    stop,
    scope: activation.scope,
    observation: activation.observation,
    diagnostics: activation.diagnostics,
  });
  activation.diagnostics.settled(activation.observation.current().loops);
  if (!began) {
    await pause(activation.pollSeconds * MS_PER_SECOND, stop.buddy);
  }
  await cycles(activation);
}

function finalLoops(loops: readonly LoopObservation[]): LoopObservation[] {
  return loops.map((loop: LoopObservation): LoopObservation => {
    if (loop.state === "held") {
      return loop;
    }
    return { ...loop, state: "stopped" };
  });
}

// Runs the buddy configured by trusted file `file` until `stop` stops it.
// Throws, before any effect, when the file or a repository config doesn't
// validate.
async function activate(file: string, stop: StopControl): Promise<BuddyRunEnd> {
  const buddy = loadBuddy(file);
  const id = newBuddyRunId();
  const startedAt = now();
  const observation = observed(
    buddyRunFile(id),
    initialObservation(id, buddy, startedAt),
  );
  const { leaseSeconds, pollSeconds } = buddy.config;
  function renew(): void {
    observation.update(
      (run: BuddyRunObservation): BuddyRunObservation => ({
        ...run,
        process: processObservation(startedAt),
        lease: leaseOf(leaseSeconds),
      }),
    );
  }
  const heartbeat = setInterval(
    renew,
    (leaseSeconds * MS_PER_SECOND) / LEASE_RENEWALS,
  );
  let failure: string | null = null;
  try {
    await cycles({
      file,
      id,
      stop,
      scope: { organization: buddy.config.scope.organization },
      trusted: digestsOf(buddy),
      pollSeconds,
      observation,
      diagnostics: buddyDiagnostics(id),
    });
  } catch (error: unknown) {
    failure = messageOf(error);
  } finally {
    clearInterval(heartbeat);
  }
  const stopped = stop.buddyStop();
  let end: BuddyRunEnd = {
    id,
    kind: "stopped",
    reason: stopped?.reason ?? "stopped",
  };
  let state: BuddyRunObservation["state"] = "stopped";
  if (failure !== null) {
    end = { id, kind: "failed", reason: failure };
    state = "ended";
  }
  observation.update(
    (run: BuddyRunObservation): BuddyRunObservation => ({
      ...run,
      process: processObservation(startedAt),
      state,
      outcome: { kind: end.kind, reason: end.reason, at: now() },
      stop: stopped,
      loops: finalLoops(run.loops),
    }),
  );
  return end;
}

export type { BuddyRunEnd };
export { activate };
