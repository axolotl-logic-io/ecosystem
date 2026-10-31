// A task run's own checkout of the issue's branch, `agent/issue-N`: a
// fresh clone in a folder no other run shares, started from the branch's
// head on GitHub when the branch exists and from the base otherwise, with
// the repository's setup run in it. Its pushes only fast-forward the
// branch: when the branch holds commits the checkout lacks, another run's,
// the checkout's work goes to a recovery branch of its own instead, and
// nothing is overwritten. Closing it bundles any commits GitHub still
// lacks into the issue's run folder before it removes the folder.

import type { JobDirs } from "@ecosystem/task-runtime/checkout";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { z } from "zod";
import { setUpCheckout } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths, withCheckout } from "../config.ts";
import { git } from "../github.ts";
import { openJobCheckout } from "../job/checkout.ts";
import { closeJobCheckout } from "../job/checkout-close.ts";
import { run, runFailure } from "../process.ts";

// What git prints when the branch moved to history the pushed head lacks.
const NOT_FAST_FORWARD =
  /\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)/u;
const RECOVERY_ID_LENGTH = 12;
const TEARDOWN = z.looseObject({
  commands: z.looseObject({ teardown: z.string().nullish() }),
});

// What a push did: published the checkout's head on the branch, found
// nothing to push, or published it on `recovery` because the branch had
// moved.
type Pushed =
  | { kind: "pushed" | "current"; head: string }
  | { kind: "diverged"; head: string; recovery: string };

interface BranchCheckout {
  dirs: JobDirs;
  head: () => string;
  // How many commits the checkout has that the base branch lacks.
  ahead: () => number;
  push: () => Pushed;
  close: () => Promise<void>;
}

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout.trim();
}

// Pushes `dir`'s HEAD to `branch` without force; true when the remote
// refused it as a non-fast-forward. Any other failure throws.
function refused(cfg: Config, dir: string, branch: string): boolean {
  const args = ["-C", dir, "push", "origin", `HEAD:refs/heads/${branch}`];
  const result = git(cfg, "dev", args, { allowFail: true });
  if (result.code === 0) {
    return false;
  }
  if (NOT_FAST_FORWARD.test(result.stderr)) {
    return true;
  }
  throw new OpsError(runFailure("git", args, result));
}

// Opens run `runId`'s checkout of issue `issue`.
function openBranchCheckout(
  cfg: Config,
  issue: number,
  runId: string,
): BranchCheckout {
  if (TEARDOWN.parse(cfg).commands.teardown) {
    throw new OpsError(
      "commands.teardown is configured, but task apps run no teardown yet; no test environment is made that teardown could not free",
    );
  }
  const stage = `task-${runId}`;
  const branch = `agent/issue-${issue}`;
  const scoped = withCheckout(cfg, {
    issue,
    dir: paths.jobRepo(cfg, issue, stage),
    branch,
  });
  const dirs = openJobCheckout(cfg, issue, { stage, branch });
  try {
    setUpCheckout(scoped, issue, dirs.repo, `${stage}-setup.log`);
  } catch (error: unknown) {
    throw new OpsError(
      `the repository's setup failed in the checkout, which is kept at ${dirs.root}: ${String(error)}`,
      { cause: error },
    );
  }
  const { repo } = dirs;
  function head(): string {
    return gitIn(repo, ["rev-parse", "HEAD"]);
  }
  return {
    dirs,
    head,
    ahead: (): number =>
      Number(
        gitIn(dirs.repo, [
          "rev-list",
          "--count",
          `origin/${cfg.baseBranch}..HEAD`,
        ]),
      ),
    push: (): Pushed => {
      const sha = head();
      const unpushed = Number(
        gitIn(dirs.repo, [
          "rev-list",
          "--count",
          "HEAD",
          "--not",
          "--remotes=origin",
        ]),
      );
      if (unpushed === 0) {
        return { kind: "current", head: sha };
      }
      if (!refused(cfg, dirs.repo, branch)) {
        return { kind: "pushed", head: sha };
      }
      const recovery = `${branch}-recovery-${runId.replaceAll("-", "").slice(0, RECOVERY_ID_LENGTH)}`;
      if (refused(cfg, dirs.repo, recovery)) {
        throw new OpsError(
          `${branch} and ${recovery} both hold other work; the checkout keeps ${sha}`,
        );
      }
      return { kind: "diverged", head: sha, recovery };
    },
    close: async (): Promise<void> => {
      await closeJobCheckout(cfg, issue, { ...dirs, key: stage }, null);
    },
  };
}

export type { BranchCheckout, Pushed };
export { openBranchCheckout };
