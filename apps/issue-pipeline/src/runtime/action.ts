// One admitted action run: the ActionContext the runtime gives a task, built
// from the stage job's infrastructure as internals (its own checkout and
// recovery bundles, its control socket and push server, its ops children
// and its model sessions with credential isolation), never from a stage
// role. The run opens its checkout, calls the task's act (or, for a
// `recover` readiness, only its read-only recover), records its end and
// settles: the checkout is preserved and removed, the model-session
// reservation released once its consumers are done, and the issue's
// execution released only when nothing about the run is uncertain.
//
// A stop, of the whole buddy run or of the action's work item alone, closes
// every boundary: no new op or model session starts, and a live session is
// asked to abort at its next safe point. Nothing is killed, so an op that
// writes, rebases or Lands runs to its own end. An action the stop
// interrupted ends stopped with outcome unknown. Checkpoints and the result
// record are evidence settlement and still run while stopping. A failed
// checkpoint, an uncertain result record, a retained rebase or any
// issue-level refusal keeps the issue's execution, and a failed checkpoint
// keeps the reservation and the checkout too.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "../config.ts";
import { withCheckout } from "../config.ts";
import type { ModelRole } from "../config-legacy.ts";
import type { InvocationBinding } from "../coordination.ts";
import type {
  ActionCause,
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  SessionResult,
  SessionSpec,
  TaskDefinition,
  WorkItemRef,
} from "../domain.ts";
import { ACTION_END } from "../domain.ts";
import { issueExecution } from "../execution.ts";
import type { JobDirs } from "../job/checkout.ts";
import { closeJobCheckout } from "../job/checkout-close.ts";
import { pushServerOf } from "../job/commit-push.ts";
import { contextLogOf } from "../job/context-log.ts";
import type { ControlSocket, LiveHandle } from "../job/control.ts";
import { openControlSocket } from "../job/control.ts";
import type { LaunchHooks } from "../job/launch.ts";
import { runSession } from "../job/launch.ts";
import type {
  LaunchOutcome,
  LaunchPush,
  LaunchRecord,
} from "../job/launch-record.ts";
import { startedRecord, withRecord } from "../job/launch-record.ts";
import { JOB_REPO } from "../job/layout.ts";
import type { OpsReply } from "../job/ops-request.ts";
import { opsFrameOf, opsRunnerOf } from "../job/ops-request.ts";
import type { PathScope } from "../job/pipeline-commit.ts";
import { commitEnvOf } from "../job/pipeline-commit.ts";
import type { PinnedPrompt } from "../job/prompts.ts";
import { PROMPTS_DIR, pinPage } from "../job/prompts.ts";
import { issueRefusal } from "../job/release-predicate.ts";
import type { SessionPhase } from "../job/role-context.ts";
import { resultOf, SESSION_MINUTES } from "../job/role-session.ts";
import { agentEnvOf, rolesOf } from "../job/roles.ts";
import type { LaunchStart } from "../job/status.ts";
import { assertCheckoutReady } from "../lane-slots.ts";
import type { TaskGuard } from "../ops/task-guard.ts";
import {
  checkGuard,
  guardedMutations,
  TASK_OP_CLASSES,
} from "../ops/task-guard.ts";
import { rebaseInProgress } from "../rebase.ts";
import type { SignalScope } from "../signals/inbox.ts";
import { requalify, stopLatch } from "../signals/inbox.ts";
import {
  ActionNotAdmitted,
  beginAction,
  finishAction,
} from "../tasks/index.ts";
import { readWriteAuthority } from "../write-authority.ts";
import type { BuddyEnvelope, BuddyRepository } from "./buddy-config.ts";
import { assertBuddyAuthorization } from "./buddy-config.ts";
import type { ActionRunId, BuddyRunId } from "./ids.ts";
import { newSessionId } from "./ids.ts";
import type {
  ActionRunObservation,
  Observed,
  SessionObservation,
} from "./observations.ts";
import { actionRunFile, observed } from "./observations.ts";
import {
  claimsTestSlot,
  laneEnvironment,
  needsPreparation,
  openActionCheckout,
  setupCommand,
  setupTimeoutMinutes,
} from "./preparation.ts";
import type { ReservationHandle } from "./reservations.ts";
import type { StopControl } from "./stop.ts";
import { pause } from "./stop.ts";

const MINUTE_MS = 60_000;
const SECOND_MS = 1000;
// The canonical evidence-only op that saves an action's checkpoint, which
// the task writer's ops provide; it still runs while the action stops.
const CHECKPOINT_OP = "checkpoint-action";
// The task-owned op that runs the configured setup in the action's checkout
// (ops/task-prepare.ts); its ops child outlives the setup's own timeout.
const PREPARE_OP = "prepare-checkout";
const PREPARE_GRACE_MINUTES = 1;
const MODEL_SESSION = "model-session";
// The model role, and so the session timeout, of each installed agent.
const AGENT_ROLES: Readonly<Record<SessionSpec["agent"], ModelRole>> = {
  "issue-pipeline-author": "author",
  "issue-pipeline-developer": "developer",
  "issue-pipeline-reviewer": "reviewer",
};
// The behavioral prompt page of each task's model session, by its phase. A
// task with no page here starts no session.
const PROMPT_PAGES: readonly {
  task: TaskDefinition["id"];
  phase: SessionPhase | null;
  page: string;
}[] = [
  { task: "author", phase: null, page: "author.md" },
  { task: "implement", phase: null, page: "developer.md" },
  { task: "harden", phase: "hardening", page: "developer-hardening.md" },
  { task: "sync", phase: "sync", page: "sync.md" },
  { task: "review-security", phase: "security-review", page: "security.md" },
];

// An action the runtime admitted (src/runtime/admission.ts): its identity,
// which is also its invocation's instance, the config bound to its confirmed
// execution and trusted authorization, the binding and signal that caused it,
// its predecessor, its model-session reservation (null for a task that
// needs none) and whether it settles a recover readiness.
interface AdmittedAction {
  id: ActionRunId;
  cfg: Config;
  execution: InvocationBinding;
  envelope: BuddyEnvelope;
  binding: Binding;
  signal: QualifiedSignal;
  cause: ActionCause;
  previous: string | null;
  reservation: ReservationHandle | null;
  mode: "act" | "recover";
}

// What an action runs under: its buddy run, the repository and its config
// file, the task, the stop control, the signal scope and how often it
// rereads its work item's stop latch.
interface ActionSetting {
  buddyRun: BuddyRunId;
  repository: BuddyRepository;
  task: TaskDefinition;
  stop: StopControl;
  scope: SignalScope;
  stopPollSeconds: number;
}

// How an action run settled.
// `notAdmitted`: the attempt's state when beginAction recorded none, so
// no action began; null once it began.
interface ActionSummary {
  id: ActionRunId;
  end: ActionEnd;
  ownership: "released" | "retained";
  reason: string | null;
  notAdmitted: "waiting" | "held" | null;
}

// Thrown at a boundary that a stop, a changed trust, a lost ownership, a
// latched stop or a revoked signal closed: the task's effect must not start.
class BoundaryClosed extends Error {}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function now(): string {
  return new Date().toISOString();
}

function unknownEnd(reason: string, state: ActionEnd["state"]): ActionEnd {
  return { state, outcome: "unknown", reason, verdict: "unknown" };
}

function outcomeOf(ok: boolean): LaunchOutcome {
  if (ok) {
    return "ok";
  }
  return "failed";
}

// The launches of the action, as the push server and the context log read
// them, each change also kept in the action's observation.
interface ActionLaunches {
  started: (launch: LaunchStart) => void;
  record: (key: string, record: unknown) => void;
  ended: (key: string) => void;
  pushed: (key: string, push: LaunchPush) => void;
  settled: (key: string, outcome: LaunchOutcome) => void;
  launch: (key: string) => LaunchRecord | null;
  currentStage: () => string;
}

function withPid<T extends { key: string; pid: number | null }>(
  rows: readonly T[],
  launch: LaunchStart,
): T[] {
  return rows.map((row: T): T => {
    if (row.key !== launch.key) {
      return row;
    }
    return { ...row, pid: launch.pid };
  });
}

function withChange<T extends { key: string }>(
  rows: readonly T[],
  key: string,
  change: Partial<T>,
): T[] {
  return rows.map((row: T): T => {
    if (row.key !== key) {
      return row;
    }
    return { ...row, ...change };
  });
}

function launchesOf(
  task: string,
  observation: Observed<ActionRunObservation>,
): ActionLaunches {
  const launches = new Map<string, LaunchRecord>();
  function change(
    key: string,
    update: (launch: LaunchRecord) => LaunchRecord,
  ): void {
    const found = launches.get(key);
    if (found !== undefined) {
      launches.set(key, update(found));
    }
  }
  return {
    started: (launch: LaunchStart): void => {
      launches.set(launch.key, startedRecord(launch));
      observation.update(
        (run: ActionRunObservation): ActionRunObservation => ({
          ...run,
          sessions: withPid(run.sessions, launch),
          operations: withPid(run.operations, launch),
        }),
      );
    },
    record: (key: string, record: unknown): void => {
      change(
        key,
        (launch: LaunchRecord): LaunchRecord => withRecord(launch, record),
      );
    },
    ended: (key: string): void => {
      const endedAt = now();
      observation.update(
        (run: ActionRunObservation): ActionRunObservation => ({
          ...run,
          sessions: withChange(run.sessions, key, { endedAt }),
          operations: withChange(run.operations, key, { endedAt }),
        }),
      );
    },
    pushed: (key: string, push: LaunchPush): void => {
      change(
        key,
        (launch: LaunchRecord): LaunchRecord => ({
          ...launch,
          pushes: [...launch.pushes, push],
        }),
      );
    },
    settled: (key: string, outcome: LaunchOutcome): void => {
      change(
        key,
        (launch: LaunchRecord): LaunchRecord => ({ ...launch, outcome }),
      );
      observation.update(
        (run: ActionRunObservation): ActionRunObservation => ({
          ...run,
          sessions: withChange(run.sessions, key, { outcome }),
          operations: withChange(run.operations, key, { outcome }),
        }),
      );
    },
    launch: (key: string): LaunchRecord | null => launches.get(key) ?? null,
    currentStage: (): string => task,
  };
}

// The pinned prompt of a session of `task` in `phase`, or why there is
// none. A page is pinned once per action, so its sessions read the same
// bytes.
function promptsOf(
  task: TaskDefinition["id"],
): (phase: SessionPhase | null) => PinnedPrompt | string {
  const pinned = new Map<string, PinnedPrompt>();
  return (phase: SessionPhase | null): PinnedPrompt | string => {
    const page = PROMPT_PAGES.find(
      (entry): boolean => entry.task === task && entry.phase === phase,
    )?.page;
    if (page === undefined) {
      return `task ${task} has no model session for phase ${String(phase)}`;
    }
    const found = pinned.get(page);
    if (found !== undefined) {
      return found;
    }
    try {
      const prompt = pinPage(PROMPTS_DIR, page);
      pinned.set(page, prompt);
      return prompt;
    } catch (error: unknown) {
      return messageOf(error);
    }
  };
}

// The scope a committing session's pipeline_commit tool commits in: the
// whole code checkout while fresh write authority permits code writes, else
// nothing. The push server rechecks authority at every push.
function commitScope(cfg: Config, issue: number): PathScope {
  const { codeWritable } = readWriteAuthority(cfg, issue);
  if (!codeWritable) {
    return { repo: { dir: JOB_REPO, access: "read" }, allowed: [] };
  }
  return { repo: { dir: JOB_REPO, access: "write" }, allowed: ["**"] };
}

// Everything an open action holds while its task runs.
interface OpenAction {
  admitted: AdmittedAction;
  setting: ActionSetting;
  workItem: WorkItemRef;
  dirs: JobDirs;
  cfg: Config;
  // Aborts once the work item or the buddy run is stopping, or once this
  // action alone is interrupted.
  signal: AbortSignal;
  // This action's own interruption: why its permission to continue was
  // withdrawn short of an accepted stop, or null. It stops nothing else.
  interruption: { controller: AbortController; reason: string | null };
  observation: Observed<ActionRunObservation>;
  launches: ActionLaunches;
  control: ControlSocket;
  checkpoint: { uncertain: string | null };
  // Whether this action's checkout passed its preparation.
  prepared: boolean;
  startedAt: string;
}

function stopReason(open: OpenAction): string {
  return (
    open.setting.stop.stopOf(open.workItem)?.reason ??
    open.interruption.reason ??
    "the action is stopping"
  );
}

// Interrupts `open` alone with `reason`, as a stop would but recording no
// stop: its sessions are asked to abort and no further boundary opens.
function interrupt(open: OpenAction, reason: string): void {
  if (open.interruption.reason !== null) {
    return;
  }
  open.interruption.reason = reason;
  open.interruption.controller.abort(reason);
}

// Asks every live model session of `open` to abort at its next safe point.
function abortSessions(open: OpenAction): void {
  for (const session of open.control.sessions.values()) {
    session.send({ type: "abort" }).catch((): null => null);
  }
}

// Throws unless the action may start another effect: not stopping, still
// authorized by its trusted configuration, still the issue's owner, with no
// stop latched on its work item and its causal signal still qualified.
async function boundaryOf(open: OpenAction, name: string): Promise<void> {
  const { cfg, signal, workItem, setting, admitted } = open;
  function close(reason: string): never {
    throw new BoundaryClosed(`${name}: ${reason}`);
  }
  if (signal.aborted) {
    close(stopReason(open));
  }
  try {
    assertBuddyAuthorization(cfg);
    issueExecution(cfg, workItem.number).assertOwner();
  } catch (error: unknown) {
    close(messageOf(error));
  }
  const latch = await stopLatch(cfg, workItem.number);
  if (latch.state === "latched") {
    setting.stop.stopWorkItem(workItem, latch.reason);
    close(latch.reason);
  }
  if (latch.state === "unknown") {
    close(`stop latch unknown: ${latch.reason}`);
  }
  const current = await requalify(cfg, setting.scope, admitted.signal);
  if (current.status !== "qualified") {
    close(`signal ${admitted.signal.id} ${current.status}: ${current.reason}`);
  }
  if (signal.aborted) {
    close(stopReason(open));
  }
}

// The boundary before finalization op `name`: the buddy's authorization
// reread and the issue's execution still the action's. A stop or a revoked
// source still lets the action's evidence settle (ops/task-guard.ts).
function finalizationBoundaryOf(open: OpenAction, name: string): void {
  try {
    assertBuddyAuthorization(open.cfg);
    issueExecution(open.cfg, open.workItem.number).assertOwner();
  } catch (error: unknown) {
    throw new BoundaryClosed(`${name}: ${messageOf(error)}`, { cause: error });
  }
}

// The boundary before op `name`, by its trusted class; an op of no class
// crosses the substantive boundary.
async function opBoundaryOf(open: OpenAction, name: string): Promise<void> {
  if (TASK_OP_CLASSES.get(name) === "finalization") {
    finalizationBoundaryOf(open, `op ${name}`);
    return;
  }
  await boundaryOf(open, `op ${name}`);
}

// What one model session of an action runs with.
interface SessionLauncher {
  open: OpenAction;
  hooks: LaunchHooks;
  prompts: (phase: SessionPhase | null) => PinnedPrompt | string;
  counts: Map<string, number>;
}

// Why the action may not run `spec` at all, or null.
function sessionRefusal(open: OpenAction, spec: SessionSpec): string | null {
  const { task } = open.setting;
  if (open.admitted.reservation === null) {
    return `task ${task.id} reserves no model session`;
  }
  if (spec.commits && task.access !== "writer") {
    return `task ${task.id} has the ${task.access} profile; its sessions cannot commit`;
  }
  if (needsPreparation(open.cfg, task) && !open.prepared) {
    return `task ${task.id}'s checkout is not prepared; it starts no session in an unprepared test environment`;
  }
  return null;
}

function keyOf(launcher: SessionLauncher, name: string): string {
  const n = (launcher.counts.get(name) ?? 0) + 1;
  launcher.counts.set(name, n);
  return `${name}-${String(n)}`;
}

// Runs one model session of `spec`, registered on the action's
// model-session reservation before it launches and reported done once its
// process exited. A session never gets a GitHub token.
async function sessionOf(
  launcher: SessionLauncher,
  spec: SessionSpec,
): Promise<SessionResult> {
  const { open } = launcher;
  const { admitted } = open;
  const { reservation } = admitted;
  const refusal = sessionRefusal(open, spec);
  if (refusal !== null || reservation === null) {
    return { ok: false, transient: false, error: refusal ?? "no reservation" };
  }
  const phase = spec.phase ?? null;
  const prompt = launcher.prompts(phase);
  if (typeof prompt === "string") {
    return { ok: false, transient: false, error: prompt };
  }
  try {
    await boundaryOf(open, "model session");
  } catch (error: unknown) {
    return { ok: false, transient: true, error: messageOf(error) };
  }
  const role = AGENT_ROLES[spec.agent];
  let name: string = role;
  if (phase !== null) {
    name = `${role}-${phase}`;
  }
  const key = keyOf(launcher, name);
  const id = newSessionId();
  const consumer = { kind: MODEL_SESSION, id };
  await reservation.register(consumer);
  const record: SessionObservation = {
    id,
    parent: admitted.id,
    key,
    agent: spec.agent,
    model: spec.model,
    phase,
    commits: spec.commits,
    pid: null,
    reservation: { slot: reservation.slot },
    startedAt: now(),
    endedAt: null,
    outcome: null,
  };
  open.observation.update(
    (run: ActionRunObservation): ActionRunObservation => ({
      ...run,
      sessions: [...run.sessions, record],
    }),
  );
  const raw = await runSession(
    {
      key,
      role,
      agent: spec.agent,
      model: spec.model,
      task: spec.task,
      outputSchema: z.toJSONSchema(spec.schema),
      timeoutMs: SESSION_MINUTES[role] * MINUTE_MS,
      commits: spec.commits,
      phase,
      prompt,
    },
    launcher.hooks,
  );
  // runSession resolves only once pi's process closed: a confirmed exit.
  await reservation.done(consumer);
  const result = resultOf(raw, spec.schema);
  open.launches.settled(key, outcomeOf(result.ok));
  return result;
}

// The whole environment of one launch of `open`: every token stripped, a
// commit scope only for a committing session, given only while the action
// still owns the issue.
function envOf(
  open: OpenAction,
  shared: Readonly<Record<string, string>>,
  scopes: Map<string, PathScope>,
): (launch: {
  key: string;
  commits: boolean;
}) => Readonly<Record<string, string>> {
  const { cfg, workItem, control, admitted, dirs, setting } = open;
  return (launch: {
    key: string;
    commits: boolean;
  }): Readonly<Record<string, string>> => {
    issueExecution(cfg, workItem.number).assertOwner();
    if (claimsTestSlot(setting.task)) {
      assertCheckoutReady(cfg, workItem.number, dirs.repo);
    }
    const leased = laneEnvironment(cfg, workItem.number, setting.task, shared);
    if (!launch.commits) {
      return leased;
    }
    const scope = commitScope(cfg, workItem.number);
    scopes.set(launch.key, scope);
    const commit = commitEnvOf({
      socket: control.socket,
      key: launch.key,
      jobStartedAt: open.startedAt,
      root: dirs.root,
      execution: admitted.execution,
      ...scope,
    });
    return { ...leased, ...commit };
  };
}

function stoppingOf(open: OpenAction): () => "SIGTERM" | null {
  return (): "SIGTERM" | null => {
    if (open.signal.aborted) {
      return "SIGTERM";
    }
    return null;
  };
}

// The launch hooks of the action: session files in its run folder, every
// launch registered with its control socket, steers and pushes on that
// socket, and each launch's environment from envOf.
function hooksOf(open: OpenAction, actionDir: string): LaunchHooks {
  const { cfg, workItem, control, launches, admitted, dirs } = open;
  const scopes = new Map<string, PathScope>();
  const contextLog = contextLogOf(
    actionDir,
    { issue: workItem.number, id: admitted.id },
    { status: launches, control: { stopping: stoppingOf(open) } },
  );
  const hooks: LaunchHooks = {
    sessionFile: (key: string): string =>
      path.join(actionDir, "sessions", `${key}.jsonl`),
    started: (launch: LaunchStart, live: LiveHandle): void => {
      launches.started({ ...launch, scope: scopes.get(launch.key) ?? null });
      control.register(live);
      if (live.kind === "session" && open.signal.aborted) {
        abortSessions(open);
      }
    },
    record: launches.record,
    ended: launches.ended,
    sessionEnded: contextLog,
    env: envOf(open, agentEnvOf(rolesOf(cfg.jobRoles), process.env), scopes),
    cwd: dirs.root,
    repo: dirs.repo,
  };
  if (cfg.runtime !== undefined) {
    hooks.runtime = cfg.runtime;
  }
  return hooks;
}

// Records checkpoint state `state` in the observation.
function noteCheckpoint(
  open: OpenAction,
  state: "saved" | "uncertain",
  reason: string | null,
): void {
  open.observation.update(
    (run: ActionRunObservation): ActionRunObservation => ({
      ...run,
      checkpoint: { state, at: now(), reason },
    }),
  );
}

// The ActionContext of `open`: its op runner frames every request with the
// action's repository config file, buddy run, invocation binding, checkout
// and buddy envelope after the task's payload, so no payload field can
// claim another.
function contextOf(open: OpenAction, actionDir: string): ActionContext {
  const { admitted, setting, cfg, dirs, workItem } = open;
  const hooks = hooksOf(open, actionDir);
  const frame = {
    ...opsFrameOf(
      cfg,
      setting.repository.file,
      {
        sweepId: setting.buddyRun,
        lane: admitted.execution.lane,
        execution: admitted.execution,
      },
      { issue: workItem.number, dir: dirs.repo, branch: dirs.branch },
    ),
    buddy: admitted.envelope,
  };
  const runOp = opsRunnerOf(workItem.number, frame, {
    hooks,
    status: open.launches,
  });
  let seq = 0;
  // Runs op `name`, observed under the key its runner gives it.
  async function recordedOp(
    name: string,
    payload: object,
    minutes?: number,
  ): Promise<OpsReply> {
    seq += 1;
    const key = `${name}-${String(seq)}`;
    open.observation.update(
      (run: ActionRunObservation): ActionRunObservation => ({
        ...run,
        operations: [
          ...run.operations,
          {
            key,
            op: name,
            pid: null,
            startedAt: now(),
            endedAt: null,
            outcome: null,
          },
        ],
      }),
    );
    return await runOp(name, payload, minutes);
  }
  // Runs the configured setup once through its guarded op; without a setup
  // command it only checks the lane barrier in process, running no op.
  async function prepare(): Promise<void> {
    const { task } = setting;
    if (admitted.mode === "recover") {
      throw new Error("recovery is read-only; it prepares no checkout");
    }
    if (!claimsTestSlot(task)) {
      throw new Error(`task ${task.id} holds no test slot to prepare`);
    }
    if (open.prepared) {
      return;
    }
    if (setupCommand(cfg) === null) {
      assertCheckoutReady(cfg, workItem.number, dirs.repo);
      open.prepared = true;
      return;
    }
    await opBoundaryOf(open, PREPARE_OP);
    const minutes = setupTimeoutMinutes(cfg) + PREPARE_GRACE_MINUTES;
    const reply = await recordedOp(PREPARE_OP, {}, minutes);
    if (!reply.ok) {
      // The end's reason reaches the public ledger, so it names no local
      // path; the op's own log and the lane store keep the details.
      throw new Error(
        `checkout preparation failed: ${PREPARE_OP} did not complete; the checkout, its lane slot and its setup barrier stay retained for explicit reconciliation, with no automatic retry`,
      );
    }
    open.prepared = true;
  }
  const launcher: SessionLauncher = {
    open,
    hooks,
    prompts: promptsOf(setting.task.id),
    counts: new Map<string, number>(),
  };
  return {
    cfg,
    workItem,
    buddyRun: setting.buddyRun,
    run: { id: admitted.id, previous: admitted.previous },
    cause: admitted.cause,
    binding: admitted.binding,
    checkout: { root: dirs.root, repo: dirs.repo, branch: dirs.branch },
    stop: open.signal,
    boundary: (name: string): Promise<void> => boundaryOf(open, name),
    op: async (name: string, payload: object): Promise<unknown> => {
      await opBoundaryOf(open, name);
      const reply = await recordedOp(name, payload);
      if (!reply.ok) {
        throw new Error(reply.error);
      }
      return reply.reply;
    },
    prepare,
    session: (spec: SessionSpec): Promise<SessionResult> =>
      sessionOf(launcher, spec),
    checkpoint: async (detail: object): Promise<void> => {
      const reply = await recordedOp(CHECKPOINT_OP, { detail });
      if (!reply.ok) {
        open.checkpoint.uncertain = reply.error;
        noteCheckpoint(open, "uncertain", reply.error);
        throw new Error(`checkpoint uncertain: ${reply.error}`);
      }
      noteCheckpoint(open, "saved", null);
    },
  };
}

// Rereads the work item's stop latch every stopPollSeconds while the action
// runs, so a stop reaches a long model session too; ends once `until`
// aborts. An unknown latch (a person's agents:stop not accepted yet, or
// unreadable evidence) withdraws this action's permission to continue: it
// interrupts this action alone, recording no stop, and its work ends
// unknown.
async function watchStopLatch(
  open: OpenAction,
  until: AbortSignal,
): Promise<void> {
  const { setting, workItem, cfg } = open;
  await pause(setting.stopPollSeconds * SECOND_MS, until);
  if (until.aborted) {
    return;
  }
  const latch = await stopLatch(cfg, workItem.number);
  if (latch.state === "latched") {
    setting.stop.stopWorkItem(workItem, latch.reason);
    return;
  }
  if (latch.state === "unknown") {
    interrupt(open, `stop latch unknown: ${latch.reason}`);
    return;
  }
  await watchStopLatch(open, until);
}

// Whether `open` was interrupted alone, with no stop of its item or run.
function interrupted(open: OpenAction): boolean {
  return (
    open.interruption.reason !== null &&
    open.setting.stop.stopOf(open.workItem) === null
  );
}

// The task's end, parsed: a malformed end, a rejection or a run interrupted
// alone is unknown; a stopped run that did not succeed ends stopped.
async function endOf(
  open: OpenAction,
  run: () => Promise<ActionEnd>,
): Promise<ActionEnd> {
  try {
    const parsed = ACTION_END.safeParse(await run());
    if (!parsed.success) {
      return unknownEnd(
        `the task's end is malformed: ${z.prettifyError(parsed.error)}`,
        "ended",
      );
    }
    if (parsed.data.outcome === "succeeded") {
      return parsed.data;
    }
    if (interrupted(open)) {
      return unknownEnd(`interrupted: ${stopReason(open)}`, "ended");
    }
    if (open.signal.aborted) {
      return { ...parsed.data, state: "stopped" };
    }
    return parsed.data;
  } catch (error: unknown) {
    if (interrupted(open)) {
      return unknownEnd(`interrupted: ${stopReason(open)}`, "ended");
    }
    if (open.signal.aborted) {
      return unknownEnd(`stopped: ${stopReason(open)}`, "stopped");
    }
    return unknownEnd(messageOf(error), "ended");
  }
}

function retainCheckout(open: OpenAction): void {
  open.observation.update(
    (run: ActionRunObservation): ActionRunObservation => ({
      ...run,
      preserved: { ...run.preserved, checkout: open.dirs.root },
    }),
  );
}

// Closes the checkout: uncommitted work saved as patches and local commits
// bundled, then removed. A stopped rebase, an uncertain checkpoint or a
// failure to preserve retains it whole. Returns why the issue must stay
// held, or null.
async function preserveCheckout(
  open: OpenAction,
  end: ActionEnd,
): Promise<string | null> {
  const { cfg, dirs, workItem, admitted, setting, checkpoint } = open;
  if (checkpoint.uncertain !== null) {
    retainCheckout(open);
    return `checkout retained at ${dirs.root}: checkpoint uncertain: ${checkpoint.uncertain}`;
  }
  if (
    fs.existsSync(path.join(dirs.repo, ".git")) &&
    rebaseInProgress(dirs.repo)
  ) {
    retainCheckout(open);
    return `a rebase is retained in ${dirs.root} for reconciliation`;
  }
  const recovery = {
    stage: setting.task.id,
    outcome: end.outcome ?? end.state,
    reason: end.reason,
  };
  try {
    const dropped = await closeJobCheckout(
      cfg,
      workItem.number,
      { ...dirs, key: admitted.id, recovery },
      null,
    );
    open.observation.update(
      (run: ActionRunObservation): ActionRunObservation => ({
        ...run,
        preserved: { checkout: null, patches: [...dropped.patches] },
      }),
    );
    return null;
  } catch (error: unknown) {
    retainCheckout(open);
    return `checkout retained at ${dirs.root}: ${messageOf(error)}`;
  }
}

// Releases the model-session reservation unless a checkpoint is uncertain;
// returns why it stays held, or null.
async function releaseReservation(open: OpenAction): Promise<string | null> {
  const { reservation } = open.admitted;
  if (reservation === null) {
    return null;
  }
  let outcome = {
    released: false,
    reason: `checkpoint uncertain: ${String(open.checkpoint.uncertain)}`,
  };
  if (open.checkpoint.uncertain === null) {
    outcome = await reservation.release();
  }
  const { released, reason } = outcome;
  let state: "held" | "released" = "held";
  if (released) {
    state = "released";
  }
  open.observation.update(
    (run: ActionRunObservation): ActionRunObservation => ({
      ...run,
      reservations: run.reservations.map((held) => {
        if (held.slot !== reservation.slot) {
          return held;
        }
        return { ...held, state, reason };
      }),
    }),
  );
  if (released) {
    return null;
  }
  return `model-session slot ${String(reservation.slot)} held: ${reason}`;
}

// Releases the issue's execution when nothing holds it; returns why it is
// retained, or null once released.
function releaseOwnership(
  open: OpenAction,
  holds: readonly (string | null)[],
): string | null {
  const { cfg, workItem, checkpoint } = open;
  let refusal = holds.find((hold): boolean => hold !== null) ?? null;
  if (refusal === null && checkpoint.uncertain !== null) {
    refusal = `checkpoint uncertain: ${checkpoint.uncertain}`;
  }
  refusal ??= issueRefusal(cfg, workItem.number);
  if (refusal !== null) {
    return refusal;
  }
  try {
    issueExecution(cfg, workItem.number).release();
    return null;
  } catch (error: unknown) {
    return `release unconfirmed: ${messageOf(error)}`;
  }
}

// Records the end of a new attempt; returns why the record is uncertain, or
// null.
async function recordEnd(
  record: (() => Promise<void>) | null,
): Promise<string | null> {
  if (record === null) {
    return null;
  }
  try {
    await record();
    return null;
  } catch (error: unknown) {
    return `the result record is uncertain: ${messageOf(error)}`;
  }
}

// How the task of an action ran: its end, the record of that end for a new
// attempt, and the attempt's state when none began.
interface TaskRun {
  end: ActionEnd;
  record: (() => Promise<void>) | null;
  notAdmitted: "waiting" | "held" | null;
}

// Settles `open` after its task ran: records the end (for a new attempt),
// preserves the checkout, releases the reservation and then the issue's
// execution, as far as nothing holds each.
async function settle(
  open: OpenAction,
  { end, record, notAdmitted }: TaskRun,
): Promise<ActionSummary> {
  const recorded = await recordEnd(record);
  open.control.close();
  const checkout = await preserveCheckout(open, end);
  const reservation = await releaseReservation(open);
  const reason = releaseOwnership(open, [recorded, checkout, reservation]);
  let ownership: ActionSummary["ownership"] = "retained";
  if (reason === null) {
    ownership = "released";
  }
  open.observation.update(
    (run: ActionRunObservation): ActionRunObservation => ({
      ...run,
      state: end.state,
      outcome: end.outcome,
      verdict: end.verdict,
      reason: end.reason,
      stop: open.setting.stop.stopOf(open.workItem),
      ownership: { state: ownership, reason },
    }),
  );
  return { id: open.admitted.id, end, ownership, reason, notAdmitted };
}

function initialObservation(
  admitted: AdmittedAction,
  setting: ActionSetting,
  workItem: WorkItemRef,
): ActionRunObservation {
  const reservations: ActionRunObservation["reservations"] = [];
  if (admitted.reservation !== null) {
    reservations.push({
      resource: "model-session",
      slot: admitted.reservation.slot,
      state: "held",
      reason: null,
    });
  }
  return {
    kind: "action-run",
    version: 1,
    id: admitted.id,
    previous: admitted.previous,
    buddyRun: setting.buddyRun,
    task: setting.task.id,
    workItem,
    binding: admitted.binding,
    cause: admitted.cause,
    execution: admitted.execution,
    mode: admitted.mode,
    authorization: admitted.envelope.authorizationDigest,
    state: "running",
    outcome: null,
    verdict: null,
    reason: null,
    stop: null,
    checkpoint: { state: "none", at: null, reason: null },
    ownership: { state: "held", reason: null },
    sessions: [],
    operations: [],
    reservations,
    preserved: { checkout: null, patches: [] },
  };
}

// Ends an action that couldn't open, holding everything it already took.
function unopened(
  admitted: AdmittedAction,
  observation: Observed<ActionRunObservation>,
  reason: string,
  checkout: string | null,
): ActionSummary {
  observation.update(
    (run: ActionRunObservation): ActionRunObservation => ({
      ...run,
      state: "ended",
      outcome: "unknown",
      verdict: "unknown",
      reason,
      preserved: { ...run.preserved, checkout },
      ownership: { state: "retained", reason },
    }),
  );
  return {
    id: admitted.id,
    end: unknownEnd(reason, "ended"),
    ownership: "retained",
    reason,
    notAdmitted: null,
  };
}

// The end of an attempt beginAction did not begin: ActionNotAdmitted's own
// state, recorded nothing; any other failure leaves whether the attempt
// was recorded unknown, which holds.
function notBegun(error: unknown): {
  end: ActionEnd;
  notAdmitted: "waiting" | "held";
} {
  const reason = `no attempt began: ${messageOf(error)}`;
  if (error instanceof ActionNotAdmitted && error.state === "waiting") {
    return {
      end: { state: "waiting", outcome: null, reason, verdict: "unknown" },
      notAdmitted: "waiting",
    };
  }
  if (error instanceof ActionNotAdmitted) {
    return {
      end: { state: "ended", outcome: null, reason, verdict: "unknown" },
      notAdmitted: "held",
    };
  }
  return { end: unknownEnd(reason, "ended"), notAdmitted: "held" };
}

// Runs the task of `open`: only its read-only recover for a recover
// readiness, else a new attempt that begins (beginAction) before its first
// effect and whose end is recorded (finishAction) at settlement.
async function runTask(open: OpenAction, ctx: ActionContext): Promise<TaskRun> {
  const { task } = open.setting;
  if (open.admitted.mode === "recover") {
    const { recover } = task;
    if (recover === undefined) {
      return {
        end: unknownEnd(`task ${task.id} has no recovery`, "ended"),
        record: null,
        notAdmitted: null,
      };
    }
    return {
      end: await endOf(open, () => recover(ctx)),
      record: null,
      notAdmitted: null,
    };
  }
  try {
    await beginAction(ctx);
  } catch (error: unknown) {
    return { ...notBegun(error), record: null };
  }
  const end = await endOf(open, () => task.act(ctx));
  return {
    end,
    record: (): Promise<void> => finishAction(ctx, end),
    notAdmitted: null,
  };
}

// Opens the action's checkout and control socket, or says why it couldn't.
async function openAction(
  admitted: AdmittedAction,
  setting: ActionSetting,
  observation: Observed<ActionRunObservation>,
  actionDir: string,
): Promise<{ open: OpenAction } | { unopened: ActionSummary }> {
  const workItem: WorkItemRef = {
    repo: admitted.cfg.repo,
    number: admitted.execution.issue,
  };
  let dirs: JobDirs;
  try {
    dirs = openActionCheckout(
      admitted.cfg,
      workItem.number,
      { stage: `action-${admitted.id}`, branch: admitted.execution.branch },
      setting.task,
    );
  } catch (error: unknown) {
    return {
      unopened: unopened(
        admitted,
        observation,
        `checkout not opened: ${messageOf(error)}`,
        null,
      ),
    };
  }
  const cfg = withCheckout(admitted.cfg, {
    issue: workItem.number,
    dir: dirs.repo,
    branch: dirs.branch,
  });
  const launches = launchesOf(setting.task.id, observation);
  // The session push's authority: the buddy's authorization, no accepted
  // or unknown stop, the action's cause still authoritative, and the
  // issue's execution still the action's. The push server checks it when a
  // push is requested and again at the credentialed push itself.
  const pushGuard: TaskGuard = {
    kind: "substantive",
    scope: setting.scope,
    number: workItem.number,
    proposed: { binding: admitted.binding, cause: admitted.cause },
  };
  function owner(): void {
    checkGuard(cfg, pushGuard);
    issueExecution(cfg, workItem.number).assertOwner();
  }
  const pushJob = {
    issue: workItem.number,
    checkout: dirs.repo,
    branch: dirs.branch,
    id: admitted.id,
    owner,
  };
  try {
    const control = await openControlSocket(
      actionDir,
      pushServerOf(guardedMutations(cfg, pushGuard), pushJob, launches),
      admitted.execution,
    );
    const interruption = {
      controller: new AbortController(),
      reason: null,
    };
    const open: OpenAction = {
      admitted,
      setting,
      workItem,
      dirs,
      cfg,
      signal: AbortSignal.any([
        setting.stop.forWorkItem(workItem),
        interruption.controller.signal,
      ]),
      interruption,
      observation,
      launches,
      control,
      checkpoint: { uncertain: null },
      prepared: false,
      startedAt: now(),
    };
    return { open };
  } catch (error: unknown) {
    return {
      unopened: unopened(
        admitted,
        observation,
        `control socket not opened: ${messageOf(error)}; checkout retained at ${dirs.root}`,
        dirs.root,
      ),
    };
  }
}

// Runs admitted action `admitted` in `setting` to its settled end. Never
// rejects for the task's sake: a failure to open its checkout or control
// socket ends it unknown and holds whatever it already took.
async function runAction(
  admitted: AdmittedAction,
  setting: ActionSetting,
): Promise<ActionSummary> {
  const workItem: WorkItemRef = {
    repo: admitted.cfg.repo,
    number: admitted.execution.issue,
  };
  const file = actionRunFile(admitted.cfg, workItem.number, admitted.id);
  const actionDir = path.dirname(file);
  const observation = observed(
    file,
    initialObservation(admitted, setting, workItem),
  );
  const opened = await openAction(admitted, setting, observation, actionDir);
  if ("unopened" in opened) {
    return opened.unopened;
  }
  const { open } = opened;
  function onStop(): void {
    abortSessions(open);
    observation.update(
      (run: ActionRunObservation): ActionRunObservation => ({
        ...run,
        stop: setting.stop.stopOf(workItem),
      }),
    );
  }
  open.signal.addEventListener("abort", onStop, { once: true });
  const finished = new AbortController();
  const watching = watchStopLatch(
    open,
    AbortSignal.any([finished.signal, open.signal]),
  ).catch((): null => null);
  const ran = await runTask(open, contextOf(open, actionDir));
  finished.abort();
  open.signal.removeEventListener("abort", onStop);
  await watching;
  return await settle(open, ran);
}

export type { ActionSetting, ActionSummary, AdmittedAction };
export { runAction };
