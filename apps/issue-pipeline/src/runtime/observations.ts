// The buddy runtime's local run observations (docs/reference/runtime-runs.md):
// one file per buddy run, `runs/buddy-runs/<id>/run.json`, and one per
// action run, `runs/<slug>/issue-<n>/actions/<id>/run.json`, under the
// pipeline root. Each is rewritten whole and atomically on every change, so
// a reader never sees part of one. They are observations, never authority:
// nothing in the pipeline reads them to decide an effect, and a write that
// fails is reported on stderr while the run goes on. Runs link to each other
// only through their explicit `previous`, `buddyRun` and session `parent`
// fields.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { INVOCATION_BINDING } from "../coordination-record-schema.ts";
import {
  ACTION_CAUSE,
  BINDING,
  RUN_STATE,
  TASK_ID,
  VERDICT,
  WORK_ITEM_REF,
} from "../domain.ts";
import { ROOT } from "../pipeline-root.ts";
import type { ActionSummary } from "./action.ts";

const OBSERVATION_FILE = "run.json";
const TIME = z.iso.datetime();
const UUID = z.uuid();
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);

// The process that holds a buddy run: liveness needs this observation to be
// fresh and its pid to match, and the lease below unexpired.
const PROCESS = z.strictObject({
  pid: z.int().positive(),
  host: z.string().min(1),
  startedAt: TIME,
  observedAt: TIME,
});
const LEASE = z.strictObject({ seconds: z.int().positive(), expiresAt: TIME });
const STOP = z.strictObject({
  scope: z.enum(["buddy", "work-item"]),
  reason: z.string().min(1),
  requestedAt: TIME,
});
const LOOP = z.strictObject({
  task: TASK_ID,
  repo: z.string().min(1),
  state: z.enum(["idle", "acting", "waiting", "held", "stopped"]),
  reason: z.string().nullable(),
  polledAt: TIME.nullable(),
  action: UUID.nullable(),
});

const BUDDY_RUN = z.strictObject({
  kind: z.literal("buddy-run"),
  version: z.literal(1),
  id: UUID,
  previous: UUID.nullable(),
  buddy: z.strictObject({
    name: z.string().min(1),
    role: z.enum(["developer", "gatekeeper"]),
    identity: z.string().min(1),
    config: z.string().min(1),
  }),
  tasks: z.array(TASK_ID),
  scope: z.strictObject({
    organization: z.string().min(1),
    repositories: z.array(
      z.strictObject({
        config: z.string().min(1),
        repo: z.string().min(1),
        base: z.string().min(1),
        authorization: SHA256,
      }),
    ),
  }),
  accounts: z.array(
    z.strictObject({ provider: z.literal("github"), login: z.string() }),
  ),
  process: PROCESS,
  lease: LEASE,
  state: RUN_STATE,
  outcome: z
    .strictObject({
      kind: z.enum(["stopped", "failed"]),
      reason: z.string().min(1),
      at: TIME,
    })
    .nullable(),
  stop: STOP.nullable(),
  loops: z.array(LOOP),
  caps: z.array(
    z.strictObject({
      repo: z.string().min(1),
      modelSessions: z.int().positive(),
      testSlots: z.int().positive().nullable(),
    }),
  ),
});

const SESSION = z.strictObject({
  id: UUID,
  parent: UUID,
  key: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1),
  phase: z.string().nullable(),
  commits: z.boolean(),
  pid: z.int().nullable(),
  reservation: z.strictObject({ slot: z.int().positive() }).nullable(),
  startedAt: TIME,
  endedAt: TIME.nullable(),
  outcome: z.enum(["ok", "failed"]).nullable(),
});
const OPERATION = z.strictObject({
  key: z.string().min(1),
  op: z.string().min(1),
  pid: z.int().nullable(),
  startedAt: TIME,
  endedAt: TIME.nullable(),
  outcome: z.enum(["ok", "failed"]).nullable(),
});
const RESERVATION = z.strictObject({
  resource: z.enum(["model-session", "test-slot", "target-write"]),
  slot: z.int().positive(),
  state: z.enum(["held", "released"]),
  reason: z.string().nullable(),
});

const ACTION_RUN = z.strictObject({
  kind: z.literal("action-run"),
  version: z.literal(1),
  id: UUID,
  previous: UUID.nullable(),
  buddyRun: UUID,
  task: TASK_ID,
  workItem: WORK_ITEM_REF,
  binding: BINDING,
  cause: ACTION_CAUSE,
  execution: INVOCATION_BINDING,
  // "act" for a new attempt; "recover" for a read-only recovery that
  // settles an earlier attempt and records none of its own.
  mode: z.enum(["act", "recover"]),
  // The action's own authorization digest (src/runtime/buddy-config.ts),
  // separate from the shared checking policy in its binding's revision.
  authorization: SHA256,
  state: RUN_STATE,
  outcome: z.enum(["succeeded", "failed", "refused", "unknown"]).nullable(),
  verdict: VERDICT.nullable(),
  reason: z.string().nullable(),
  stop: STOP.nullable(),
  checkpoint: z.strictObject({
    state: z.enum(["none", "saved", "uncertain"]),
    at: TIME.nullable(),
    reason: z.string().nullable(),
  }),
  ownership: z.strictObject({
    state: z.enum(["held", "released", "retained"]),
    reason: z.string().nullable(),
  }),
  sessions: z.array(SESSION),
  operations: z.array(OPERATION),
  reservations: z.array(RESERVATION),
  preserved: z.strictObject({
    checkout: z.string().nullable(),
    patches: z.array(z.string()),
  }),
});

type BuddyRunObservation = z.infer<typeof BUDDY_RUN>;
type ActionRunObservation = z.infer<typeof ACTION_RUN>;
type LoopObservation = z.infer<typeof LOOP>;
type StopObservation = z.infer<typeof STOP>;
type SessionObservation = z.infer<typeof SESSION>;
type ProcessObservation = z.infer<typeof PROCESS>;

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buddyRunsDir(): string {
  return path.join(ROOT, "runs", "buddy-runs");
}

function buddyRunFile(id: string): string {
  return path.join(buddyRunsDir(), id, OBSERVATION_FILE);
}

function actionRunFile(cfg: Config, issue: number, id: string): string {
  return path.join(paths.runDir(cfg, issue), "actions", id, OBSERVATION_FILE);
}

// Writes `value` to `file` whole: a temp file renamed over it. A failure is
// reported, never thrown: an observation never stops a run.
function writeObservation(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temp, file);
  } catch (error: unknown) {
    fs.rmSync(temp, { force: true });
    process.stderr.write(`buddy: cannot write ${file}: ${messageOf(error)}\n`);
  }
}

function readObservation<T>(file: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (parsed.success) {
      return parsed.data;
    }
    return null;
  } catch {
    return null;
  }
}

// The latest earlier buddy run of buddy `name`, by its process start, or
// null with none: the new run's explicit `previous`. A malformed file is
// skipped; it is only an observation.
function previousBuddyRun(name: string): string | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(buddyRunsDir());
  } catch {
    return null;
  }
  const runs = entries
    .map((entry) => readObservation(buddyRunFile(entry), BUDDY_RUN))
    .filter((run) => run !== null && run.buddy.name === name);
  let latest: BuddyRunObservation | null = null;
  for (const run of runs) {
    if (
      run !== null &&
      (latest === null || run.process.startedAt > latest.process.startedAt)
    ) {
      latest = run;
    }
  }
  return latest?.id ?? null;
}

// This process as a fresh observation.
function processObservation(startedAt: string): ProcessObservation {
  return {
    pid: process.pid,
    host: os.hostname(),
    startedAt,
    observedAt: new Date().toISOString(),
  };
}

// An observation kept current: `update` changes it and rewrites its file.
type LoopLocation = Pick<LoopObservation, "repo" | "task">;
interface BuddyDiagnostics {
  held: (where: LoopLocation, reason: string) => void;
  settled: (loops: readonly LoopObservation[]) => void;
  ended: (where: LoopLocation, summary: ActionSummary) => void;
}

// Stderr diagnostics supplement run records; neither grants runtime authority.
// Remember holds across the poll's temporary idle reset, until a whole cycle
// clears them. JSON keeps multiline reasons within one physical log line.
function buddyDiagnostics(id: string): BuddyDiagnostics {
  const holds = new Map<string, string>();
  return {
    held: (where: LoopLocation, reason: string): void => {
      const key = JSON.stringify([where.repo, where.task]);
      if (holds.get(key) === reason) {
        return;
      }
      holds.set(key, reason);
      process.stderr.write(
        `${JSON.stringify({
          at: new Date().toISOString(),
          buddyRun: id,
          ...where,
          state: "held",
          reason,
        })}\n`,
      );
    },
    settled: (loops: readonly LoopObservation[]): void => {
      for (const loop of loops) {
        if (loop.state !== "held") {
          holds.delete(JSON.stringify([loop.repo, loop.task]));
        }
      }
    },
    ended: (where: LoopLocation, summary: ActionSummary): void => {
      if (summary.notAdmitted !== null || summary.end.outcome === "succeeded") {
        return;
      }
      process.stderr.write(
        `${JSON.stringify({
          at: new Date().toISOString(),
          buddyRun: id,
          ...where,
          action: summary.id,
          ...summary.end,
        })}\n`,
      );
    },
  };
}

interface Observed<T> {
  current: () => T;
  update: (change: (now: T) => T) => void;
}

function observed<T>(file: string, initial: T): Observed<T> {
  let now = initial;
  writeObservation(file, now);
  return {
    current: (): T => now,
    update: (change: (was: T) => T): void => {
      now = change(now);
      writeObservation(file, now);
    },
  };
}

export type {
  ActionRunObservation,
  BuddyDiagnostics,
  BuddyRunObservation,
  LoopObservation,
  Observed,
  SessionObservation,
  StopObservation,
};
export {
  ACTION_RUN,
  actionRunFile,
  BUDDY_RUN,
  buddyDiagnostics,
  buddyRunFile,
  observed,
  previousBuddyRun,
  processObservation,
};
