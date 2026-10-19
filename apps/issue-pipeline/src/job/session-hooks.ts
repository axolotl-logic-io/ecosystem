// What a stage job's launches tell its status file, context log and
// control, and the environment each session runs with: the job's own less
// every gh token (roles.ts), and, for a session given commit authority, the
// scope its pipeline_commit tool commits in (pipeline-commit.ts). Authority
// is the session's own, never its agent's.

import type { Config } from "../config.ts";
import { paths, wikiCfg, withCheckout } from "../config.ts";
import { issueEnvironment } from "../issue-environment.ts";
import { readWriteAuthority } from "../write-authority.ts";
import type { RunArgs } from "./args.ts";
import { contextLogOf } from "./context-log.ts";
import type { Control, LiveHandle } from "./control.ts";
import type { LaunchHooks } from "./launch.ts";
import type { PathScope } from "./pipeline-commit.ts";
import { commitEnvOf } from "./pipeline-commit.ts";
import type { EnvSource } from "./roles.ts";
import { agentEnvOf, commitScopeOf, rolesOf } from "./roles.ts";
import type { JobStatus, LaunchStart } from "./status.ts";

// What the job's launches report to.
interface JobWatch {
  status: JobStatus;
  control: Control;
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
  const { status, control } = watch;
  const { cwd, repo, from, job } = where;
  const shared = {
    ...agentEnvOf(rolesOf(cfg.jobRoles), from),
    ...Object.fromEntries(issueEnvironment(cfg, args.issue)),
  };
  const scopes = new Map<string, PathScope>();
  const scoped = withCheckout(cfg, {
    issue: args.issue,
    dir: repo,
    branch: args.branch,
  });
  return {
    sessionFile: (key: string): string => paths.session(cfg, args.issue, key),
    started: (launch: LaunchStart, live: LiveHandle): void => {
      status.started({ ...launch, scope: scopes.get(launch.key) ?? null });
      control.register(live);
    },
    record: status.record,
    ended: status.ended,
    sessionEnded: contextLogOf(
      paths.runDir(cfg, args.issue),
      { issue: args.issue, id: job.id },
      watch,
    ),
    env: (launch: {
      key: string;
      commits: boolean;
    }): Readonly<Record<string, string>> => {
      if (!launch.commits) {
        return shared;
      }
      const { key } = launch;
      const { state, codeWritable } = readWriteAuthority(scoped, args.issue);
      if (state.stage !== args.stage) {
        throw new Error(
          `saved stage ${state.stage} cannot authorize a ${args.stage} writer session`,
        );
      }
      const scope = commitScopeOf(
        args.stage,
        wikiCfg(cfg) !== null,
        codeWritable,
      );
      scopes.set(key, scope);
      const { socket } = control;
      const { startedAt: jobStartedAt } = job;
      const session = { socket, key, jobStartedAt, root: cwd };
      const commit = commitEnvOf({ ...session, ...scope });
      return { ...shared, ...commit };
    },
    cwd,
    repo,
    runtime: cfg.runtime,
  };
}

export type { JobWatch };
export { hooksOf };
