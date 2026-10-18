// What finish-sync checks a rebase a writer resolved against, before it
// pushes it, and the push and reset that sync-base and finish-sync share
// (sync.ts).

import { recordPush } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { head, remoteHead } from "../git-state.ts";
import { git } from "../github.ts";
import { run } from "../process.ts";
import { abortRebase, rebaseProblem } from "../rebase.ts";
import { holdWikiPin, wikiPinProblem } from "../wiki.ts";

// The commit sync-base rebased onto (its reply's baseSha, #279).
interface FinishAgainst {
  baseSha?: string | null | undefined;
}

// What the resolved rebase in `wt` is checked against, or why it can't be.
// With a baseSha it is checked against that commit,
// which must be on the base, so a base that moved during the fix doesn't
// throw the resolution away.
function finishTarget(
  cfg: Config,
  wt: string,
  { baseSha }: FinishAgainst,
): { onto: string } | { problem: string } {
  const base = `origin/${cfg.baseBranch}`;
  if (baseSha === null || baseSha === undefined || baseSha === "") {
    return { onto: base };
  }
  const ancestor = ["-C", wt, "merge-base", "--is-ancestor", baseSha, base];
  if (run("git", ancestor, { allowFail: true }).code !== 0) {
    return { problem: `${baseSha} is not on ${base}` };
  }
  return { onto: baseSha };
}

// Why issue `n`'s resolved rebase can't be pushed, or undefined when it can:
// the rebase's own checks against its target (finishTarget), then the wiki
// pin against the one the branch's own commits on GitHub give.
function finishProblem(
  cfg: Config,
  n: number,
  against: FinishAgainst,
): string | undefined {
  const wt = paths.worktree(cfg, n);
  const target = finishTarget(cfg, wt, against);
  if ("problem" in target) {
    return target.problem;
  }
  const { onto } = target;
  const problem = rebaseProblem(wt, onto);
  const from = remoteHead(cfg, n);
  if (problem !== undefined || from === null) {
    return problem;
  }
  return wikiPinProblem(cfg, wt, { from, onto });
}

// Puts the worktree back on the pushed branch, dropping a half-done rebase.
function resetToRemote(cfg: Config, n: number): void {
  const wt = paths.worktree(cfg, n);
  abortRebase(wt);
  const remote = remoteHead(cfg, n);
  if (remote !== null) {
    run("git", ["-C", wt, "reset", "--hard", remote]);
  }
  run("git", ["-C", wt, "clean", "-fd"]);
  holdWikiPin(cfg, wt);
}

// Pushes the worktree's head as the issue's branch for `op`, recording the
// push first.
function pushBranch(cfg: Config, n: number, wt: string, op: string): void {
  const target = `HEAD:refs/heads/${paths.branch(cfg, n)}`;
  recordPush(cfg, n, head(wt), op);
  git(cfg, ["-C", wt, "push", "--force-with-lease", "origin", target]);
}

export { finishProblem, pushBranch, resetToRemote };
