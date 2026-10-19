// A role's model sessions in a stage job (src/job/role-run.ts): each runs as
// one of the job's launches (src/job/launch.ts), as the one installed agent
// the stage may run, with the write authority its spec asks for and the stage
// allows (sessionRefusalOf in roles.ts), with the behavioral prompt the job
// pinned for its stage and phase (src/job/brain.ts), always fresh and
// bounded only by its wall-clock timeout. Its reply is the structured_output tool's,
// parsed once more by the role's schema here, the only reply check
// (`one-review-session`). Every finished session's usage goes to the usage
// log, and its outcome to job.json.

import { z } from "zod";
import type { Config } from "../config.ts";
import type { ModelRole } from "../config-legacy.ts";
import type { ShellProcess } from "../shell-command.ts";
import type { Stage } from "../stages.ts";
import type { Brain, PinnedPrompt } from "./brain.ts";
import { setupContext } from "./checkout.ts";
import type { LaunchHooks } from "./launch.ts";
import { runSession } from "./launch.ts";
import type { SessionRaw } from "./raw-results.ts";
import type { SessionResult, SessionSpec } from "./role-context.ts";
import { STAGE_AGENTS, sessionRefusalOf } from "./roles.ts";
import type { RunUsage, UsageEntry } from "./run-usage.ts";
import type { JobStatus } from "./status.ts";
import { isTransientSessionError } from "./transient.ts";
import { usageTally } from "./usage-tally.ts";

const MINUTE_MS = 60_000;
const MS_PER_SECOND = 1000;
// Each role's session timeout: its only bound (`no-session-budgets`). The
// implementor's is the installed version's longest writer session's.
const SESSION_MINUTES: Readonly<Record<ModelRole, number>> = {
  author: 30,
  implementor: 60,
  reviewer: 30,
};
// The error of a session asked for once the job's stop began; it is
// transient, so the role defers and nothing is counted.
const STOPPING = "the job is stopping";

// What the sessions read of their job.
interface SessionJob {
  cfg: Config;
  issue: number;
  stage: Stage;
  brain: Brain;
  hooks: LaunchHooks;
  status: Pick<JobStatus, "settled">;
  stopping: () => unknown;
  usage: RunUsage;
  append: (entry: UsageEntry) => Promise<void>;
}

function refused(error: string): SessionResult {
  return { ok: false, transient: false, error };
}

// The session's result: its reply parsed by `schema`, or why it failed.
function resultOf(raw: SessionRaw, schema: z.ZodType): SessionResult {
  if (!raw.ok) {
    const error = raw.error ?? "the session failed";
    return { ok: false, transient: isTransientSessionError(error), error };
  }
  const parsed = schema.safeParse(raw.structuredOutput);
  if (!parsed.success) {
    return refused(
      `the reply doesn't match its schema: ${z.prettifyError(parsed.error)}`,
    );
  }
  return { ok: true, reply: parsed.data };
}

// Runs `spec` as launch `key` for `role` with `prompt` and records its
// outcome and usage.
async function runAs(
  job: SessionJob,
  spec: SessionSpec,
  launch: { key: string; role: ModelRole; prompt: PinnedPrompt },
): Promise<SessionResult> {
  const { key, role, prompt } = launch;
  const tally = usageTally();
  const hooks: LaunchHooks = {
    ...job.hooks,
    record: (launchKey: string, record: unknown): void => {
      tally.record(record);
      job.hooks.record(launchKey, record);
    },
  };
  const startedAt = Date.now();
  const { agent, model, task, schema, commits } = spec;
  const phase = spec.phase ?? null;
  const outputSchema = z.toJSONSchema(schema);
  const timeoutMs = SESSION_MINUTES[role] * MINUTE_MS;
  const raw = await runSession(
    {
      key,
      role,
      agent,
      model,
      task,
      outputSchema,
      timeoutMs,
      commits,
      phase,
      prompt,
    },
    hooks,
  );
  const result = resultOf(raw, schema);
  let reply: unknown = null;
  let outcome: "ok" | "failed" = "failed";
  if (result.ok) {
    ({ reply } = result);
    outcome = "ok";
  }
  job.status.settled(key, outcome);
  const seconds = (Date.now() - startedAt) / MS_PER_SECOND;
  const entry = job.usage.session({
    at: new Date(),
    key,
    stage: job.stage,
    phase,
    role,
    agent,
    model,
    taskChars: task.length,
    prompt: prompt.provenance,
    ok: result.ok,
    reply,
    launch: tally.usage(seconds),
    signalled: job.stopping() !== null,
  });
  await job.append(entry);
  return result;
}

// The job's session runner. A spec the stage may not run, or one the job
// pinned no prompt for, fails without starting, and so does one asked for
// once the job's stop began. Keys are
// `<role>-<n>`, counting each role's sessions in the job.
function sessionRunnerOf(
  job: SessionJob,
): (spec: SessionSpec) => Promise<SessionResult> {
  const counts = new Map<ModelRole, number>();
  return async (spec: SessionSpec): Promise<SessionResult> => {
    const refusal = sessionRefusalOf(job.stage, spec);
    if (refusal !== null) {
      return refused(refusal);
    }
    const prompt = job.brain.promptFor(job.stage, spec.phase ?? null);
    if (prompt === null) {
      return refused(`the job pinned no prompt for this ${job.stage} session`);
    }
    if (job.stopping() !== null) {
      return { ok: false, transient: true, error: STOPPING };
    }
    const { role } = STAGE_AGENTS[job.stage];
    const n = (counts.get(role) ?? 0) + 1;
    counts.set(role, n);
    const key = `${role}-${n}`;
    const setup = await setupContext(job.cfg, job.issue, {
      stage: job.stage,
      key,
      repo: job.hooks.repo,
      started: (child: ShellProcess): void => {
        const setupKey = `setup-${key}`;
        job.hooks.started(
          { key: setupKey, kind: "ops", pid: child.pid, session: null },
          { kind: "ops", ops: { key: setupKey, ...child } },
        );
        child.exited
          .then((): void => job.hooks.ended(setupKey))
          .catch(() => null);
      },
    });
    if (job.stopping() !== null) {
      return { ok: false, transient: true, error: STOPPING };
    }
    const prepared = { ...spec, task: `${spec.task}\n\n${setup}` };
    return await runAs(job, prepared, { key, role, prompt });
  };
}

export type { SessionJob };
export { sessionRunnerOf };
