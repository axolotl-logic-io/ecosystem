// Model sessions for a task app's work. Each session is a fresh `pi`
// process (job/launch.ts) as an installed agent, with its pinned prompt
// page, in the run's checkout folder; none reads another's conversation,
// and none gets a GitHub token. A committing session commits through
// `pipeline_commit`, whose push request reaches the caller's `push` over a
// control socket in the run's folder, so each commit is pushed as it is
// made.
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { SessionProfile } from "../config-schema.ts";
import type { SessionPhase, SessionResult } from "../domain.ts";
import { agentEnvOf } from "../job/agent-env.ts";
import type { JobDirs } from "../job/checkout.ts";
import type { LiveHandle } from "../job/control.ts";
import { openControlSocket } from "../job/control.ts";
import type { PushReply } from "../job/control-protocol.ts";
import type { LaunchHooks } from "../job/launch.ts";
import { runSession } from "../job/launch.ts";
import { JOB_REPO } from "../job/layout.ts";
import { commitEnvOf } from "../job/pipeline-commit.ts";
import { PROMPTS_DIR, pinPage } from "../job/prompts.ts";
import type { InvocationBinding } from "../job/session-identity.ts";
import { resultOf, SESSION_MINUTES } from "../job/session-result.ts";

const MINUTE_MS = 60_000;
// One session: the model profile it plays, the prompt page it follows, its
// phase, its task text, the shape of its reply and whether it commits.
interface TaskSession {
  profile: SessionProfile;
  page: string;
  phase: SessionPhase | null;
  task: string;
  schema: z.ZodType;
  commits: boolean;
}
interface Sessions {
  run: (session: TaskSession) => Promise<SessionResult>;
  // Asks every live session to abort at its next safe point.
  abort: () => void;
  close: () => void;
}
// Where the sessions run: the run's folder, which holds their session
// files and control socket, and its checkout. `binding` names the run to
// its sessions' push requests; `push` pushes what a committing session
// committed and says what it pushed.
interface SessionSetting {
  dir: string;
  checkout: JobDirs;
  binding: InvocationBinding;
  push: () => PushReply;
  env?: Readonly<Record<string, string>>;
}

// Opens the sessions of `cfg`'s repository in `setting`.
async function openSessions(
  cfg: Config,
  setting: SessionSetting,
): Promise<Sessions> {
  const { checkout, binding } = setting;
  const committing = new Set<string>();
  const control = await openControlSocket(
    setting.dir,
    (key: string): PushReply => {
      if (!committing.has(key)) {
        return { pushed: "none", pushError: `${key} is no committing session` };
      }
      return setting.push();
    },
    binding,
  );
  const startedAt = new Date().toISOString();
  const shared = {
    ...agentEnvOf(cfg.jobRoles, process.env),
    ...setting.env,
  };
  const hooks: LaunchHooks = {
    sessionFile: (key: string): string =>
      path.join(setting.dir, "sessions", `${key}.jsonl`),
    started: (_launch: unknown, live: LiveHandle): void => {
      control.register(live);
    },
    record: (): void => undefined,
    ended: (): void => undefined,
    sessionEnded: (): void => undefined,
    env: (launch: {
      key: string;
      commits: boolean;
    }): Readonly<Record<string, string>> => {
      if (!launch.commits) {
        return shared;
      }
      committing.add(launch.key);
      return {
        ...shared,
        ...commitEnvOf({
          socket: control.socket,
          key: launch.key,
          jobStartedAt: startedAt,
          root: checkout.root,
          execution: binding,
          repo: { dir: JOB_REPO, access: "write" },
          allowed: ["**"],
        }),
      };
    },
    cwd: checkout.root,
    repo: checkout.repo,
  };
  if (cfg.runtime !== undefined) {
    hooks.runtime = cfg.runtime;
  }
  let count = 0;
  return {
    run: async (session: TaskSession): Promise<SessionResult> => {
      count += 1;
      const prompt = pinPage(PROMPTS_DIR, session.page);
      const raw = await runSession(
        {
          key: `${session.phase ?? session.profile}-${count}`,
          profile: session.profile,
          agent: `issue-pipeline-${session.profile}`,
          model: cfg.models[session.profile],
          task: session.task,
          outputSchema: z.toJSONSchema(session.schema),
          timeoutMs: SESSION_MINUTES[session.profile] * MINUTE_MS,
          commits: session.commits,
          phase: session.phase,
          prompt,
        },
        hooks,
      );
      return resultOf(raw, session.schema);
    },
    abort: (): void => {
      for (const live of control.sessions.values()) {
        live.send({ type: "abort" }).catch((): null => null);
      }
    },
    close: control.close,
  };
}

export type { Sessions, TaskSession };
export { openSessions };
