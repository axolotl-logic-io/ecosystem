// Stacked branches (#268): an issue whose branch starts on another issue's
// branch, its prerequisite, rather than on the base branch, until the
// prerequisite merges. This module holds every decision about a stack: where
// a stacked branch starts, what a sync rebases it onto and when it unstacks,
// and what the issue's own change is measured from.

import { z } from "zod";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { fetchIn, remoteHead } from "./git-state.ts";
import { ghJson } from "./github.ts";
import { mergeCommitFor, mergedPrFor } from "./ops/prs.ts";
import { OpsError, run } from "./process.ts";

// The prerequisite issue and the head of its branch the stacked branch was
// last put on.
const STACKED_ON = z.object({
  issue: z.number().int().positive(),
  headSha: z.string().min(1),
});

// gh's answer to an issue's state, its state_reason renamed, or null when it
// printed nothing.
const ISSUE_CLOSE = z
  .looseObject({ state: z.unknown(), reason: z.unknown() })
  .nullable();

type StackedOn = z.infer<typeof STACKED_ON>;

// `git merge-base --is-ancestor`'s exit code when the commit isn't an
// ancestor; any other failure is an error.
const NOT_ANCESTOR = 1;

// What a sync rebases: the commits after `upstream`, onto `onto`. `stackedOn`
// is what the issue is stacked on once the sync is done, null when it isn't.
interface SyncTarget {
  onto: string;
  upstream: string;
  stackedOn: StackedOn | null;
}

function prereqRef(issue: number): string {
  return `origin/${paths.branch(issue)}`;
}

function gitSucceeds(dir: string, args: readonly string[]): boolean {
  return run("git", ["-C", dir, ...args], { allowFail: true }).code === 0;
}

// Fetches prerequisite `issue`'s branch into `dir` and returns its head, or
// null when GitHub has no such branch.
function fetchPrereq(cfg: Config, dir: string, issue: number): string | null {
  if (remoteHead(cfg, issue) === null) {
    return null;
  }
  const branch = paths.branch(issue);
  fetchIn(cfg, dir, `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  return run("git", ["-C", dir, "rev-parse", prereqRef(issue)]).stdout.trim();
}

// Where a branch stacked on issue `prereq` starts: that issue's branch head,
// fetched into `dir` as origin/agent/issue-<prereq>. Throws when GitHub has
// no such branch.
function stackStart(cfg: Config, dir: string, prereq: number): StackedOn {
  const headSha = fetchPrereq(cfg, dir, prereq);
  if (headSha === null) {
    throw new OpsError(
      `can't stack on #${prereq}: it has no branch ${paths.branch(prereq)} on GitHub`,
    );
  }
  return { issue: prereq, headSha };
}

// True when prerequisite `issue` has merged: a PR from its branch merged, or
// the issue was closed as completed.
function prereqMerged(cfg: Config, issue: number): boolean {
  if (mergedPrFor(cfg, issue) !== undefined) {
    return true;
  }
  const args = [
    "api",
    `repos/${cfg.repo}/issues/${issue}`,
    "--jq",
    "{state, reason: .state_reason}",
  ];
  const closed = ISSUE_CLOSE.parse(ghJson(cfg, args));
  return closed?.state === "closed" && closed.reason === "completed";
}

// True when the branch on GitHub of open prerequisite `prereq` lacks the merge
// commit of some issue in `merged` whose PR merged (#328). Each merge commit
// is the base's head just after that PR merged, so later moves of the base
// don't count. False when none of them has a merged PR, and when gh or git
// can't tell, as when the prerequisite has no branch or there is no clone.
function prereqBehind(
  cfg: Config,
  prereq: number,
  merged: readonly number[],
): boolean {
  try {
    const commits = merged.flatMap((n) => mergeCommitFor(cfg, n) ?? []);
    if (commits.length === 0) {
      return false;
    }
    const clone = paths.clone(cfg);
    fetchIn(cfg, clone, cfg.baseBranch);
    const head = fetchPrereq(cfg, clone, prereq);
    if (head === null) {
      return false;
    }
    return commits.some((commit) => {
      const args = ["-C", clone, "merge-base", "--is-ancestor", commit, head];
      return run("git", args, { allowFail: true }).code === NOT_ANCESTOR;
    });
  } catch (error: unknown) {
    if (
      error instanceof OpsError ||
      error instanceof SyntaxError ||
      error instanceof z.ZodError
    ) {
      return false;
    }
    throw error;
  }
}

// What a sync of the branch in `dir` rebases onto, with the base fetched:
// the base when the issue isn't stacked or its prerequisite merged, and the
// prerequisite's branch head otherwise. Only the commits after the saved
// prerequisite head are replayed, unless that head isn't in the branch's
// history any more, when the rebase is a plain one. Throws when the
// prerequisite hasn't merged and its branch is gone.
function syncTarget(
  cfg: Config,
  dir: string,
  stackedOn: StackedOn | null | undefined,
): SyncTarget {
  const base = `origin/${cfg.baseBranch}`;
  fetchIn(cfg, dir, cfg.baseBranch);
  if (stackedOn === null || stackedOn === undefined) {
    return { onto: base, upstream: base, stackedOn: null };
  }
  const { issue, headSha: saved } = stackedOn;
  let target: SyncTarget = { onto: base, upstream: base, stackedOn: null };
  if (!prereqMerged(cfg, issue)) {
    const headSha = fetchPrereq(cfg, dir, issue);
    if (headSha === null) {
      throw new OpsError(
        `#${issue}, which this issue is stacked on, hasn't merged and has no branch ${paths.branch(issue)} on GitHub`,
      );
    }
    const onto = prereqRef(issue);
    target = { onto, upstream: onto, stackedOn: { issue, headSha } };
  }
  if (gitSucceeds(dir, ["merge-base", "--is-ancestor", saved, "HEAD"])) {
    target.upstream = saved;
  }
  return target;
}

// Moves a worktree with no commits of its own, on neither the base nor the
// prerequisite it is stacked on, to where the issue starts: that
// prerequisite's head, or the base's head on GitHub. It drops the edits. A
// worktree with commits of its own is kept. Commits up to `unstackedHead`,
// the head of a merged prerequisite the issue unstacked from, aren't its own.
function resetToStart(
  cfg: Config,
  wt: string,
  stackedOn: StackedOn | null,
  unstackedHead: string | null = null,
): void {
  const base = cfg.baseBranch;
  fetchIn(cfg, wt, `+refs/heads/${base}:refs/remotes/origin/${base}`);
  let start = `origin/${base}`;
  const known = [start];
  if (stackedOn !== null) {
    start = stackedOn.headSha;
    known.push(start);
  }
  if (
    unstackedHead !== null &&
    gitSucceeds(wt, ["cat-file", "-e", `${unstackedHead}^{commit}`])
  ) {
    known.push(unstackedHead);
  }
  const range = ["rev-list", "--count", "HEAD", "--not", ...known];
  if (Number(run("git", ["-C", wt, ...range]).stdout) !== 0) {
    return;
  }
  run("git", ["-C", wt, "reset", "--hard", start]);
  run("git", ["-C", wt, "clean", "-fd"]);
}

// What a claimed issue is stacked on, and the merged prerequisite it
// unstacked from, with the head the saved state last put it on, if any.
interface ClaimedStack {
  stackedOn: StackedOn | null;
  unstacked: { issue: number; headSha: string | null } | null;
}

// What a claimed issue is stacked on. With no branch of its own on GitHub
// (`remote` null), that is the prerequisite the claim (`stackOn`) or the
// saved state names, at its branch's head now, fetched into `dir`, unless
// that prerequisite has merged, its branch deleted or not: then the issue
// unstacks and starts from the base. With a branch of its own, it is what
// the saved state says, and `stackOn` is ignored; a sync unstacks it.
function claimedStack(
  cfg: Config,
  dir: string,
  claim: {
    remote: string | null;
    saved: StackedOn | null | undefined;
    stackOn: number | null | undefined;
  },
): ClaimedStack {
  const kept = claim.saved ?? null;
  const prereq = claim.stackOn ?? kept?.issue;
  if (claim.remote !== null || prereq === undefined) {
    return { stackedOn: kept, unstacked: null };
  }
  if (prereqMerged(cfg, prereq)) {
    let headSha: string | null = null;
    if (kept?.issue === prereq) {
      ({ headSha } = kept);
    }
    return { stackedOn: null, unstacked: { issue: prereq, headSha } };
  }
  return { stackedOn: stackStart(cfg, dir, prereq), unstacked: null };
}

// What the issue's own change is measured from: the prerequisite head it is
// stacked on, or the base branch.
function measureFrom(
  stackedOn: StackedOn | null | undefined,
  cfg: Config,
): string {
  if (stackedOn === null || stackedOn === undefined) {
    return `origin/${cfg.baseBranch}`;
  }
  return stackedOn.headSha;
}

export type { ClaimedStack, StackedOn, SyncTarget };
export {
  claimedStack,
  measureFrom,
  prereqBehind,
  prereqMerged,
  resetToStart,
  STACKED_ON,
  stackStart,
  syncTarget,
};
