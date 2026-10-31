// A task app's private writing checkout and credential-free Developer
// session. GitHub's pushed branch is the starting point for every run.
// Commits use the existing commit tool; its socket identity is local to
// this process and requires no coordination claims or task records.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { JobDirs } from "@ecosystem/task-runtime/checkout";
import {
  type LiveHandle,
  openControlSocket,
  stopLaunch,
} from "@ecosystem/task-runtime/job/control";
import type { PushReply } from "@ecosystem/task-runtime/job/control-protocol";
import type { LaunchHooks } from "@ecosystem/task-runtime/job/launch";
import { COMMIT_SCOPE_ENV } from "@ecosystem/task-runtime/job/pipeline-commit";
import { pinPage } from "@ecosystem/task-runtime/job/prompts";
import {
  resultOf,
  SESSION_MINUTES,
} from "@ecosystem/task-runtime/job/session-result";
import type { LaunchStart } from "@ecosystem/task-runtime/job/status";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { publishCheckout } from "@ecosystem/task-runtime/publish-checkout";
import { conflictStages } from "@ecosystem/task-runtime/rebase";
import { z } from "zod";
import { setUpCheckout } from "../checkouts.ts";
import { type Config, loadConfig, paths } from "../config.ts";
import { gitIn } from "../git-state.ts";
import { git } from "../github.ts";
import { agentEnvOf } from "../job/agent-env.ts";
import { openJobCheckout } from "../job/checkout.ts";
import { runSession } from "../job/launch.ts";
import { promptsDir } from "../job/prompts.ts";
import { run } from "../process.ts";
import type { TaskRun } from "../task-app/task-app.ts";

const MINUTE_MS = 60_000;
const STOP_POLL_MS = 5000;
const COMMIT_ENV = new Map([
  ["ISSUE_PIPELINE_COMMIT", "1"],
  ["GIT_EDITOR", "true"],
]);

interface Writer {
  cfg: Config;
  dirs: JobDirs;
  conflicts: string[];
  push: () => string;
  session: <T>(task: string, schema: z.ZodType<T>) => Promise<T>;
  remove: () => void;
}

// Opens a fresh checkout, merges the base without rebasing and keeps
// conflicts for the session. Failed runs keep their folder for a person.
function openWriter(taskRun: TaskRun, head: string, base: string): Writer {
  const loaded = loadConfig(taskRun.config);
  const cfg: Config = {
    ...loaded,
    gitAccount: taskRun.gitAccount,
    devAccount: taskRun.account,
  };
  if (cfg.laneSlots !== undefined) {
    throw new OpsError("task app writing does not support laneSlots yet");
  }
  taskRun.checkStop();
  const dirs = openJobCheckout(cfg, taskRun.issue.number, {
    stage: `${taskRun.task}-${taskRun.run}`,
    branch: paths.branch(cfg, taskRun.issue.number),
  });
  if (gitIn(dirs.repo, ["rev-parse", "HEAD"]).trim() !== head) {
    throw new OpsError(`PR head moved; checkout retained at ${dirs.root}`);
  }
  taskRun.checkStop();
  const target = gitIn(dirs.repo, ["rev-parse", `origin/${base}`]).trim();
  const merged = run("git", ["-C", dirs.repo, "merge", "--no-edit", target], {
    env: COMMIT_ENV,
    allowFail: true,
  });
  const conflicts = gitIn(dirs.repo, ["diff", "--name-only", "--diff-filter=U"])
    .trim()
    .split("\n")
    .filter(Boolean);
  if (merged.code !== 0 && conflicts.length === 0) {
    throw new OpsError(`base merge failed: ${merged.stderr}`);
  }
  if (conflictStages(dirs.repo).some((entry) => entry.mode === "160000")) {
    throw new OpsError(
      `merge conflicts on a submodule; checkout retained at ${dirs.root}`,
    );
  }
  function push(): string {
    return publishCheckout(
      {
        repository: dirs.repo,
        branch: dirs.branch,
        expectedHead: head,
        baseHead: target,
      },
      {
        checkStop: taskRun.checkStop,
        push: (args: readonly string[]): void => {
          git(cfg, "dev", args);
        },
      },
    );
  }
  return {
    cfg,
    dirs,
    conflicts,
    push,
    session: async <T>(task: string, schema: z.ZodType<T>): Promise<T> => {
      taskRun.checkStop();
      setUpCheckout(
        cfg,
        taskRun.issue.number,
        dirs.repo,
        `setup-${taskRun.run}.log`,
      );
      return await writeSession({ taskRun, cfg, dirs, push }, task, schema);
    },
    remove: (): void => fs.rmSync(dirs.root, { recursive: true, force: true }),
  };
}

async function writeSession<T>(
  writer: { taskRun: TaskRun; cfg: Config; dirs: JobDirs; push: () => string },
  task: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const { taskRun, cfg, dirs, push } = writer;
  const key = `developer-${taskRun.task}-1`;
  const runDir = path.join(
    paths.runDir(cfg, taskRun.issue.number),
    "task-runs",
    taskRun.run,
  );
  const execution = {
    instance: taskRun.run,
    lane: taskRun.task,
    issue: taskRun.issue.number,
    branch: dirs.branch,
    repo: cfg.repo,
    base: cfg.baseBranch,
  };
  const control = await openControlSocket(
    runDir,
    (requested: string): PushReply => {
      if (requested !== key) {
        return { pushed: "none", pushError: "unknown session" };
      }
      try {
        push();
        return { pushed: "code", pushError: null };
      } catch (error) {
        return { pushed: "none", pushError: String(error) };
      }
    },
    execution,
  );
  const env = agentEnvOf(cfg.jobRoles, process.env);
  const scope = {
    root: dirs.root,
    repo: { dir: "repo", access: "write" },
    allowed: ["**"],
    socket: control.socket,
    key,
    execution,
    jobStartedAt: new Date().toISOString(),
  };
  const hooks: LaunchHooks = {
    sessionFile: (name: string): string =>
      path.join(runDir, "sessions", `${name}.jsonl`),
    started: (_launch: LaunchStart, live: LiveHandle): void =>
      control.register(live),
    record: (): void => undefined,
    ended: (): void => undefined,
    sessionEnded: (): void => undefined,
    env: (): Readonly<Record<string, string>> => ({
      ...env,
      [COMMIT_SCOPE_ENV]: JSON.stringify(scope),
    }),
    cwd: dirs.root,
    repo: dirs.repo,
  };
  if (cfg.runtime !== undefined) {
    hooks.runtime = cfg.runtime;
  }
  let stopped: unknown = null;
  const timer = setInterval((): void => {
    if (stopped !== null) {
      return;
    }
    try {
      taskRun.checkStop();
    } catch (error) {
      stopped = error;
      for (const live of control.sessions.values()) {
        stopLaunch(live).catch(() => null);
      }
    }
  }, STOP_POLL_MS);
  try {
    const raw = await runSession(
      {
        key,
        profile: "developer",
        agent: "issue-pipeline-developer",
        model: cfg.models.developer,
        task,
        outputSchema: z.toJSONSchema(schema),
        timeoutMs: SESSION_MINUTES.developer * MINUTE_MS,
        commits: true,
        phase: "fix",
        prompt: pinPage(promptsDir(), "fix.md"),
      },
      hooks,
    );
    if (stopped !== null) {
      throw stopped;
    }
    taskRun.checkStop();
    const result = resultOf(raw, schema);
    if (!result.ok) {
      throw new OpsError(`writing session failed: ${result.error}`);
    }
    return schema.parse(result.reply);
  } finally {
    clearInterval(timer);
    control.close();
  }
}

export type { Writer };
export { openWriter };
