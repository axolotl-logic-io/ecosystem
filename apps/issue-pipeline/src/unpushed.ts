// An issue's unpushed commits are never dropped (#283). A stop during
// implement pushes the worktree's and the wiki checkout's commits that GitHub
// lacks to the issue's branch, and says in the stop comment which stayed only
// local. A claim that moves a worktree to the branch on GitHub first saves
// any commits the branch lacks under refs/pipeline/rescue/<n>/<stamp>, and
// keeps HEAD unless someone pushed to the branch since.

import { confirmedPush } from "./assignment/checkpoint.ts";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { fetchIn, gitIn, head, remoteHead } from "./git-state.ts";
import { git } from "./github.ts";
import { OpsError } from "./ops-error.ts";
import { run } from "./process.ts";
import { pushWikiBranch } from "./wiki.ts";
import { readWriteAuthority } from "./write-authority.ts";

// The separators an ISO time has that a rescue ref's stamp drops, with its
// milliseconds: 2026-10-16T12:34:56.789Z becomes 20261016T123456Z.
const ISO_SEPARATORS = /[-:]|\.\d+/gu;
// How much of a head the log names.
const LOG_SHA_LENGTH = 8;
const LOG_STAMP_LENGTH = 16;

// How many commits `range` has, less those reachable from each of `not`.
function commitsAhead(dir: string, range: string, ...not: string[]): number {
  const args = ["rev-list", "--count", range];
  if (not.length > 0) {
    args.push("--not", ...not);
  }
  return Number(gitIn(dir, args).trim());
}

// The head of the checkout at `dir`, or null when there is none.
function headOrNull(dir: string): string | null {
  const args = ["-C", dir, "rev-parse", "--verify", "--quiet", "HEAD"];
  const found = run("git", args, { allowFail: true });
  if (found.code !== 0) {
    return null;
  }
  return found.stdout.trim();
}

function onlyLocal(what: string, sha: string): string {
  return `The ${what} checkout's commits are only local: its push was refused or failed, so they are at ${sha} on this machine, not on GitHub.`;
}

// Pushes the worktree's commits that the issue's branch on GitHub (or, with
// no branch there, the base) lacks. Only fast-forwards an existing branch.
// Commits already on the base are on GitHub, so a checkout at the base's
// merge commit of the issue (merged-review.ts) pushes nothing.
function pushCode(cfg: Config, n: number): string[] {
  const wt = paths.worktree(cfg, n);
  const sha = headOrNull(wt);
  if (sha === null) {
    return [];
  }
  try {
    const remote = remoteHead(cfg, n);
    const base = cfg.baseBranch;
    const onBase = `origin/${base}`;
    fetchIn(cfg, wt, `+refs/heads/${base}:refs/remotes/origin/${base}`);
    let range = `${onBase}..HEAD`;
    if (remote !== null) {
      fetchIn(cfg, wt, paths.branch(cfg, n));
      range = `${remote}..HEAD`;
    }
    if (commitsAhead(wt, range, onBase) > 0) {
      const target = `HEAD:refs/heads/${paths.branch(cfg, n)}`;
      if (!readWriteAuthority(cfg, n).codeWritable) {
        throw new OpsError(
          `#${n}'s code merged; stop salvage cannot push code`,
        );
      }
      confirmedPush(cfg, n, "code", (): void => {
        git(cfg, "dev", ["-C", wt, "push", "origin", target]);
      });
    }
    return [];
  } catch {
    return [onlyLocal("code", sha)];
  }
}

function pushWiki(cfg: Config, n: number): string[] {
  try {
    pushWikiBranch(cfg, n);
    return [];
  } catch {
    const sha = headOrNull(paths.wiki(cfg, n)) ?? "an unknown head";
    return [onlyLocal("wiki", sha)];
  }
}

// Pushes issue `n`'s unpushed code and wiki commits to its agent/issue-<n>
// branches. Never throws: returns one stop-comment line per checkout whose
// push failed, naming its head, and none when everything reached GitHub or
// there was nothing to push.
function pushUnpushed(cfg: Config, n: number): string[] {
  return [...pushCode(cfg, n), ...pushWiki(cfg, n)];
}

// Moves the worktree `wt` of issue `n` to `remote`, its branch head on GitHub
// (already fetched), dropping no commit the branch lacks. With none, it
// resets and cleans the worktree and returns null. Otherwise it saves HEAD as
// refs/pipeline/rescue/<n>/<stamp>, keeps HEAD and the working tree when
// `remote` is behind it, resets to `remote` when the two diverged, and
// returns the log entry saying which.
function resetKeepingUnpushed(
  wt: string,
  n: number,
  remote: string,
  now: Date,
): string | null {
  const ahead = commitsAhead(wt, `${remote}..HEAD`);
  let entry: string | null = null;
  if (ahead > 0) {
    const sha = head(wt);
    const iso = now.toISOString();
    const ref = `refs/pipeline/rescue/${n}/${iso.replace(ISO_SEPARATORS, "")}`;
    gitIn(wt, ["update-ref", ref, sha]);
    const args = ["-C", wt, "merge-base", "--is-ancestor", remote, "HEAD"];
    const kept = run("git", args, { allowFail: true }).code === 0;
    let outcome = "reset to the branch, which someone pushed to since";
    if (kept) {
      outcome = "kept HEAD";
    }
    const short = sha.slice(0, LOG_SHA_LENGTH);
    entry = `${iso.slice(0, LOG_STAMP_LENGTH)}Z saved ${ahead} unpushed commit(s) at ${short} as ${ref}; ${outcome}`;
    if (kept) {
      return entry;
    }
  }
  gitIn(wt, ["reset", "--hard", remote]);
  gitIn(wt, ["clean", "-fd"]);
  return entry;
}

export { pushUnpushed, resetKeepingUnpushed };
