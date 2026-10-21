// A role stage's usage bookkeeping (src/job/role-run.ts): how each session
// ended, the stages the job went through and the tokens its sessions spent,
// as the usage log's entries (src/job/usage-log.ts). It is telemetry only;
// nothing here limits a session. It does no I/O.

import type { ModelRole } from "../config-legacy.ts";
import type { Status } from "../stages.ts";
import type { PromptProvenance } from "./prompts.ts";
import type { SessionPhase } from "./role-context.ts";
import type { Usage } from "./token-usage.ts";
import { addUsage, ZERO_USAGE } from "./token-usage.ts";
import type { Ended } from "./usage-log.ts";
import type { LaunchUsage } from "./usage-tally.ts";

const MS_PER_SECOND = 1000;

// What the job knows of a finished session.
interface SessionEntry {
  kind: "session";
  at: string;
  // The session's launch key, which its commits' trailers name.
  key: string;
  stage: string;
  state: string;
  name: string;
  agent: string;
  model: string;
  attempt: number;
  taskChars: number;
  // The prompt page its prompt was pinned from, its sha256 and its head
  // (src/job/prompts.ts).
  prompt: Omit<PromptProvenance, "path">;
  ended: Ended;
  reply: unknown;
  launch: LaunchUsage;
}

// What a job knows of its finished run: how its stage ended.
interface JobEntry {
  kind: "job";
  at: string;
  stages: readonly string[];
  outcome: string;
  seconds: number;
  tokens: Usage;
}

type UsageEntry = SessionEntry | JobEntry;

// A session as it finished: when, its launch key, the role it played as
// which agent and model at which stage and in which reviewer phase (null
// for none), its task's length, its pinned prompt's provenance, whether it
// replied and its schema-checked reply, its usage, and whether a signal
// came while it ran.
interface FinishedSession {
  at: Date;
  key: string;
  stage: string;
  phase: SessionPhase | null;
  role: ModelRole;
  agent: string;
  model: string;
  taskChars: number;
  prompt: PromptProvenance;
  ok: boolean;
  reply: unknown;
  launch: LaunchUsage;
  signalled: boolean;
}

// One job's bookkeeping.
interface RunUsage {
  // The entry of a finished session, whose tokens the job entry adds.
  session: (finished: FinishedSession) => SessionEntry;
  // The job saved the issue at `stage`.
  moved: (stage: Status) => void;
  // The job's entry once its stage ended as `outcome`.
  job: (outcome: string, at: Date) => JobEntry;
}

// How a session ended: aborted by a signal, with its reply, or failed.
function endedOf(finished: Pick<FinishedSession, "ok" | "signalled">): Ended {
  if (finished.signalled) {
    return "aborted";
  }
  if (!finished.ok) {
    return "error";
  }
  return "reply";
}

// The bookkeeping of a job that starts at `stage` at `startedAt`. Sessions
// of the same role count up as attempts 1, 2, … A session's record names its
// reviewer phase as its state, else its stage.
function runUsage(stage: string, startedAt: Date): RunUsage {
  const stages = [stage];
  const attempts = new Map<string, number>();
  let tokens: Usage = ZERO_USAGE;
  return {
    session: (finished: FinishedSession): SessionEntry => {
      const { launch, role } = finished;
      const { page, sha256, head } = finished.prompt;
      tokens = addUsage(tokens, launch.tokens);
      const attempt = (attempts.get(role) ?? 0) + 1;
      attempts.set(role, attempt);
      let reply: unknown = null;
      if (finished.ok) {
        ({ reply } = finished);
      }
      return {
        kind: "session",
        at: finished.at.toISOString(),
        key: finished.key,
        stage: finished.stage,
        state: finished.phase ?? finished.stage,
        name: role,
        agent: finished.agent,
        model: finished.model,
        attempt,
        taskChars: finished.taskChars,
        prompt: { page, sha256, head },
        ended: endedOf(finished),
        reply,
        launch,
      };
    },
    moved: (next: Status): void => {
      stages.push(next);
    },
    job: (outcome: string, at: Date): JobEntry => ({
      kind: "job",
      at: at.toISOString(),
      stages: [...stages],
      outcome,
      seconds: (at.getTime() - startedAt.getTime()) / MS_PER_SECOND,
      tokens,
    }),
  };
}

export type { FinishedSession, JobEntry, RunUsage, SessionEntry, UsageEntry };
export { endedOf, runUsage };
