// A stage job's run of the sweep (src/job.ts) for a stage with no registered
// role: it runs each batch the sweep's driver asks for, up to the spawn cap,
// feeding the results back, and on a stop saves the issue it held. As each
// model session ends it appends the session's usage entry, and at the job's
// end the job's, through the usage effect (usage-append.ts), as a role
// stage's job does. A session's role is its stage's, as the wiki's
// Pipeline-Roles page lists them; its state and name are its launch's name,
// and it is its launch's first attempt. The job's issueTokens are the
// claimed issue's reportedTokens as the sweep counts them.

import { roleOfStage } from "../orchestrator/roles.ts";
import type { RoleName } from "../roles/registry.ts";
import { parseOps } from "../workflow/launch-results.ts";
import type { ChildSpec, LaunchSpec, OpsFrame } from "../workflow/launches.ts";
import { opsSpec } from "../workflow/launches.ts";
import type { StageName, SweepSummary } from "../workflow/stages/types.ts";
import { STAGE_ORDER } from "../workflow/sweep-config.ts";
import type { Sweep } from "../workflow/types.ts";
import type { Control } from "./control.ts";
import type { LaunchHooks } from "./launch.ts";
import { runLaunch } from "./launch.ts";
import { runAll } from "./pool.ts";
import type { OpsRaw, SessionRaw } from "./raw-results.ts";
import { tallied } from "./role-run.ts";
import type { UsageEntry } from "./run-usage.ts";
import { endedOf, sessionOutcome } from "./run-usage.ts";
import type { JobStatus, StopSignal } from "./status.ts";
import type { Usage } from "./token-usage.ts";
import { addUsage, ZERO_USAGE } from "./token-usage.ts";
import { usageAppender } from "./usage-append.ts";
import type { UsageContext } from "./usage-log.ts";
import { usageTally } from "./usage-tally.ts";

const MS_PER_SECOND = 1000;
// A session key's issue prefix and launch count (launches.ts).
const KEY_ISSUE = /^i\d+-/u;
const KEY_SEQ = /-\d+$/u;
// The name of the usage op's launches, which no sweep launch has.
const USAGE_LAUNCH = "usage-log";
// The outcome of a job a stop ended, and of one whose sweep held no issue.
const INTERRUPTED = "interrupted";
const NO_ITEM = "none";
// What a usage record may name as a stage: STAGE_ORDER and done.
const RECORDED_STAGES: readonly string[] = [...STAGE_ORDER, "done"];

// How a sweep run ended: finished with its summary, or stopped by a signal.
type DrivenEnd =
  | { kind: "finished"; summary: SweepSummary }
  | { kind: "stopped"; signal: StopSignal };

// A job on the sweep's driven path: its stage, its launches' hooks, status
// and control, its spawn cap and ops frame, its records' identity, less the
// role each record's stage gives, and the issue's run folder.
interface DrivenJob {
  stage: StageName;
  hooks: LaunchHooks;
  status: JobStatus;
  control: Control;
  limit: number;
  frame: OpsFrame;
  usage: Omit<UsageContext, "role">;
  runDir: string;
}

// One run's usage: its sessions' tokens, the stages its issue was at, and
// how each entry is appended.
interface DrivenUsage {
  tokens: Usage;
  stages: string[];
  append: (stage: string, entry: UsageEntry) => Promise<void>;
}

function isStage(stage: string): stage is StageName {
  return STAGE_ORDER.some((name) => name === stage);
}

// The role at `stage`, or the job's own stage's when `stage` is none.
function roleAt(stage: string, job: DrivenJob): RoleName {
  if (isStage(stage)) {
    return roleOfStage(stage);
  }
  return roleOfStage(job.stage);
}

function isChild(spec: LaunchSpec): spec is ChildSpec {
  return "model" in spec;
}

// The launch name in a session key, "i<n>-<name>-<seq>" (launches.ts).
function launchNameOf(key: string): string {
  return key.replace(KEY_ISSUE, "").replace(KEY_SEQ, "");
}

// The usage of `job`'s run, whose records it sends through the usage op.
function drivenUsage(job: DrivenJob): DrivenUsage {
  const { issue } = job.usage;
  let seq = 0;
  async function send(line: string): Promise<boolean> {
    seq += 1;
    const name = `i${issue}-${USAGE_LAUNCH}`;
    const payload = { line, number: issue };
    const launch = { kind: "op" as const, name, op: "usage", payload };
    const spec = opsSpec(job.frame, seq, launch, null);
    const { ok } = parseOps(await runLaunch(spec, job.hooks));
    if (ok !== true) {
      job.status.settled(spec.key, "failed");
      return false;
    }
    job.status.settled(spec.key, "ok");
    return true;
  }
  return {
    tokens: ZERO_USAGE,
    stages: [job.stage],
    append: (stage: string, entry: UsageEntry): Promise<void> => {
      const context = { ...job.usage, role: roleAt(stage, job) };
      return usageAppender(context, { send, runDir: job.runDir })(entry);
    },
  };
}

// Notes the stage the claimed issue is at, as the job's next stage.
function noteStage(usage: DrivenUsage, sweep: Sweep): void {
  const stage = sweep.claimed()?.stage;
  if (
    stage !== undefined &&
    RECORDED_STAGES.includes(stage) &&
    usage.stages.at(-1) !== stage
  ) {
    usage.stages.push(stage);
  }
}

// Runs session `spec`, tallying what it spent, and appends its entry.
async function runSession(
  spec: ChildSpec,
  job: DrivenJob,
  run: { usage: DrivenUsage; sweep: Sweep },
): Promise<SessionRaw | OpsRaw> {
  const { usage, sweep } = run;
  const stage = sweep.claimed()?.stage ?? job.stage;
  const tally = usageTally(job.hooks.contextLimits.soft);
  const startedAt = Date.now();
  const raw = await runLaunch(spec, tallied(job.hooks, tally));
  const launch = tally.usage((Date.now() - startedAt) / MS_PER_SECOND);
  const outcome = sessionOutcome(raw);
  const signalled = job.control.stopping() !== null;
  usage.tokens = addUsage(usage.tokens, launch.tokens);
  const name = launchNameOf(spec.key);
  let reply: unknown = null;
  if (outcome.ok) {
    ({ reply } = outcome);
  }
  await usage.append(stage, {
    kind: "session",
    at: new Date().toISOString(),
    key: spec.key,
    stage,
    state: name,
    name,
    agent: spec.agent,
    model: spec.model,
    attempt: 1,
    taskChars: spec.task.length,
    schema: spec.outputSchema,
    ended: endedOf({ outcome, launch, signalled }),
    reply,
    launch,
  });
  return raw;
}

// Runs each batch the sweep asks for, feeding its results back, until the
// sweep asks for none or a signal stops the job. A stop starts no more
// launches and throws the batch's results away.
async function drive(
  sweep: Sweep,
  job: DrivenJob,
  usage: DrivenUsage,
): Promise<StopSignal | null> {
  async function next(
    specs: readonly LaunchSpec[],
  ): Promise<StopSignal | null> {
    noteStage(usage, sweep);
    if (specs.length === 0) {
      return null;
    }
    const results = await runAll(
      specs,
      job.limit,
      async (spec: LaunchSpec): Promise<OpsRaw | SessionRaw | null> => {
        if (job.control.stopping() !== null) {
          return null;
        }
        if (isChild(spec)) {
          return await runSession(spec, job, { usage, sweep });
        }
        return await runLaunch(spec, job.hooks);
      },
    );
    const signal = job.control.stopping();
    if (signal !== null) {
      return signal;
    }
    specs.forEach(({ key }: LaunchSpec, index: number): void => {
      let outcome: "ok" | "failed" = "failed";
      if (results[index]?.ok === true) {
        outcome = "ok";
      }
      job.status.settled(key, outcome);
    });
    return await next(sweep.next(results));
  }
  return await next(sweep.next([]));
}

// The job's end as its record names it.
function outcomeOf(end: DrivenEnd): string {
  if (end.kind === "stopped") {
    return INTERRUPTED;
  }
  return end.summary.items[0]?.outcome ?? NO_ITEM;
}

// Drives the sweep to its end, or to a stop and saves the issue it held,
// then appends the job's usage entry.
async function runDriven(sweep: Sweep, job: DrivenJob): Promise<DrivenEnd> {
  const usage = drivenUsage(job);
  const signal = await drive(sweep, job, usage);
  let end: DrivenEnd;
  if (signal === null) {
    end = { kind: "finished", summary: sweep.summary() };
  } else {
    const save = sweep.interrupt();
    if (save !== null) {
      await runLaunch(save, job.hooks);
    }
    end = { kind: "stopped", signal };
  }
  const at = new Date();
  const started = Date.parse(job.usage.jobStartedAt);
  await usage.append(job.stage, {
    kind: "job",
    at: at.toISOString(),
    stages: usage.stages,
    outcome: outcomeOf(end),
    seconds: (at.getTime() - started) / MS_PER_SECOND,
    tokens: usage.tokens,
    issueTokens: sweep.claimed()?.reportedTokens ?? 0,
  });
  return end;
}

export type { DrivenEnd, DrivenJob };
export { runDriven };
