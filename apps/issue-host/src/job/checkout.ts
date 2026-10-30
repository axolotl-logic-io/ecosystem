// Compatibility host translates private configuration into checkout operations.

import type {
  GitAccess,
  JobDirs,
  RepositorySource,
} from "@ecosystem/task-runtime/checkout";
import {
  openBaseCheckout as openBase,
  openJobCheckout as openJob,
} from "@ecosystem/task-runtime/checkout";
import type { Config } from "../config.ts";
import { paths, withCheckout } from "../config.ts";
import { git } from "../github.ts";
import { withCloneLock } from "../mirror-lock.ts";

function repositorySource(cfg: Config): RepositorySource {
  return {
    mirror: paths.mirror(cfg),
    url: cfg.cloneUrl || `https://github.com/${cfg.repo}.git`,
    base: cfg.baseBranch,
  };
}
function checkoutAccess(cfg: Config): GitAccess {
  return {
    run: (args: readonly string[]): ReturnType<typeof git> =>
      git(cfg, "dev", args),
    withMirrorLock: <T>(operation: () => T): T => withCloneLock(cfg, operation),
  };
}
function openBaseCheckout(cfg: Config, dir: string): string {
  return openBase(repositorySource(cfg), dir, checkoutAccess(cfg));
}
function openJobCheckout(
  cfg: Config,
  issue: number,
  job: { stage: string; branch: string },
): JobDirs {
  const repo = paths.jobRepo(cfg, issue, job.stage);
  const scoped = withCheckout(cfg, { issue, dir: repo, branch: job.branch });
  return openJob(
    {
      ...repositorySource(cfg),
      root: paths.jobCheckout(cfg, issue, job.stage),
      repo,
      branch: paths.branch(scoped, issue),
      identity: {
        name: cfg.gitName || cfg.devAccount,
        email: cfg.gitEmail || `${cfg.devAccount}@users.noreply.github.com`,
      },
    },
    checkoutAccess(cfg),
  );
}

export { checkoutAccess, openBaseCheckout, openJobCheckout, repositorySource };
