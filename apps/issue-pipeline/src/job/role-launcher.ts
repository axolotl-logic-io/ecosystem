// A role stage job's launches (src/job/role-run.ts): each op and session of
// the role runs as one of the job's launches (src/job/launch.ts), keyed by
// its sequence number, with its outcome in job.json. A session's usage is
// tallied from its records, its reply check answers on the job's control
// socket while it runs, and a sessions effect's sessions start in cache
// order (src/job/cache-order.ts).

import type { SessionEffect } from "../roles/machine.ts";
import type { SessionsEffect } from "../roles/sessions.ts";
import { parseOps } from "../workflow/launch-results.ts";
import type { OpsFrame } from "../workflow/launches.ts";
import { childSpec, opsSpec } from "../workflow/launches.ts";
import type { LaunchMeta } from "../workflow/signing.ts";
import type { OpLaunch } from "../workflow/stages/types.ts";
import { inCacheOrder, onFirstTurn } from "./cache-order.ts";
import type { ContextStop } from "./context-watch.ts";
import type { Control } from "./control.ts";
import type { LaunchHooks } from "./launch.ts";
import { runLaunch } from "./launch.ts";
import { replyFiller } from "./reply-file.ts";
import type { Reply } from "./role-launches.ts";
import { sessionLaunchOf, succeeded } from "./role-launches.ts";
import type { ReplyCheck, SessionRun } from "./run-step.ts";
import { sessionOutcome } from "./run-usage.ts";
import type { JobStatus } from "./status.ts";
import type { UsageTally } from "./usage-tally.ts";
import { usageTally } from "./usage-tally.ts";

const MS_PER_SECOND = 1000;

// What the launcher reads of a role stage's job: the issue, its code
// checkout, the ops frame, and the job's hooks, status and control.
interface LauncherJob {
  issue: number;
  repo: string;
  frame: OpsFrame;
  hooks: LaunchHooks;
  status: JobStatus;
  control: Control;
}

// The job's launches for the role: each op and session gets the next
// sequence number in its key, and its outcome in job.json. A session's reply
// check answers on the job's control socket while the session runs; both it
// and the role read the reply with its reply file filled in. A sessions
// effect's sessions start in cache order (src/job/cache-order.ts).
interface Launcher {
  op: (launch: OpLaunch) => Promise<Reply>;
  session: (
    effect: SessionEffect,
    replyCheck?: ReplyCheck,
  ) => Promise<SessionRun>;
  sessions: (effect: SessionsEffect) => Promise<readonly SessionRun[]>;
}

// The job's hooks, which also feed every record and stop to `tally`.
function tallied(hooks: LaunchHooks, tally: UsageTally): LaunchHooks {
  return {
    ...hooks,
    record: (key: string, record: unknown): void => {
      tally.record(key, record);
      hooks.record(key, record);
    },
    contextStopped: (key: string, stop: ContextStop): void => {
      tally.contextStopped(key);
      hooks.contextStopped(key, stop);
    },
  };
}

function launcherOf(job: LauncherJob): Launcher {
  let seq = 0;
  const meta: Record<string, LaunchMeta> = {};
  function settled(key: string, ok: boolean): void {
    let outcome: "ok" | "failed" = "failed";
    if (ok) {
      outcome = "ok";
    }
    job.status.settled(key, outcome);
  }
  // Runs session `effect`, calling `turned` on its first message_end, with
  // `replyCheck` answering on the control socket while it runs.
  async function session(
    effect: SessionEffect,
    turned: () => void,
    replyCheck?: ReplyCheck,
  ): Promise<SessionRun> {
    seq += 1;
    const item = { n: job.issue, worktree: job.repo };
    const spec = childSpec(seq, item, sessionLaunchOf(effect), meta);
    const tally = usageTally(job.hooks.contextLimits.soft);
    const startedAt = Date.now();
    const fill = replyFiller(job.repo, effect.replyFile);
    let release: (() => void) | null = null;
    if (replyCheck !== undefined) {
      release = job.control.checkReplies(spec.key, (reply: unknown) =>
        replyCheck(fill(reply)),
      );
    }
    const hooks = onFirstTurn(tallied(job.hooks, tally), turned);
    const raw = await runLaunch(spec, hooks);
    release?.();
    settled(spec.key, raw.ok);
    const seconds = (Date.now() - startedAt) / MS_PER_SECOND;
    const launch = tally.usage(seconds);
    const outcome = sessionOutcome(raw);
    if (outcome.ok) {
      outcome.reply = fill(outcome.reply);
    }
    return { outcome, launch, key: spec.key };
  }
  return {
    op: async (launch: OpLaunch): Promise<Reply> => {
      seq += 1;
      const spec = opsSpec(job.frame, seq, launch, null);
      const reply = parseOps(await runLaunch(spec, job.hooks));
      settled(spec.key, succeeded(reply));
      return reply;
    },
    session: (
      effect: SessionEffect,
      replyCheck?: ReplyCheck,
    ): Promise<SessionRun> => session(effect, () => undefined, replyCheck),
    sessions: (effect: SessionsEffect): Promise<SessionRun[]> =>
      inCacheOrder(effect.sessions, session),
  };
}

export type { Launcher, LauncherJob };
export { launcherOf, tallied };
