// What a stage job's launches tell its status file, context log and
// control, and the environment each session runs with: the job's own less
// every gh token (roles.ts), and, for a writer session, the scope its
// pipeline_commit tool commits in (pipeline-commit.ts).

import type { Config } from "../config.ts";
import { paths, wikiCfg } from "../config.ts";
import type { RunArgs } from "./args.ts";
import { contextLogOf } from "./context-log.ts";
import type { Control, LiveHandle } from "./control.ts";
import type { LaunchHooks } from "./launch.ts";
import { commitEnvOf } from "./pipeline-commit.ts";
import type { EnvSource } from "./roles.ts";
import { agentEnvOf, commitScopeOf, commitsOf, rolesOf } from "./roles.ts";
import type { JobStatus, LaunchStart } from "./status.ts";

// What the job's launches report to.
interface JobWatch {
  status: JobStatus;
  control: Control;
  resumePoint: LaunchHooks["resumePoint"];
}

// The launch hooks of the job `args` names, whose sessions run in its folder
// `cwd`, which holds its code checkout `repo`, with the job's environment
// `from`; the job's random id and start are `job`.
function hooksOf(
  cfg: Config,
  args: RunArgs,
  watch: JobWatch,
  where: {
    cwd: string;
    repo: string;
    from: EnvSource;
    job: { id: string; startedAt: string };
  },
): LaunchHooks {
  const { status, control, resumePoint } = watch;
  const { cwd, repo, from, job } = where;
  const shared = agentEnvOf(rolesOf(cfg.jobRoles), from);
  const scope = commitScopeOf(args.stage, wikiCfg(cfg) !== null);
  return {
    sessionFile: (key: string): string => paths.session(cfg, args.issue, key),
    resumePoint,
    started: (launch: LaunchStart, live: LiveHandle): void => {
      status.started(launch);
      control.register(live);
    },
    record: status.record,
    ended: status.ended,
    contextLimits: cfg.contextLimits,
    handoffFile: paths.handoff(cfg, args.issue),
    contextStopped: status.contextStopped,
    sessionEnded: contextLogOf(
      paths.runDir(cfg, args.issue),
      { issue: args.issue, id: job.id },
      watch,
    ),
    env: (agent: string, key: string): Readonly<Record<string, string>> => {
      if (!commitsOf(agent)) {
        return shared;
      }
      const { socket } = control;
      const { startedAt: jobStartedAt } = job;
      const session = { socket, key, jobStartedAt, root: cwd };
      const commit = commitEnvOf({ ...session, ...scope });
      return { ...shared, ...commit };
    },
    cwd,
    repo,
  };
}

export type { JobWatch };
export { hooksOf };
