// Bringing an issue's wiki commits onto the wiki's latest version. syncWiki
// rebases the issue's wiki checkout onto the wiki's branch before the code
// merges; finishWikiSync checks and keeps a rebase a writer resolved; and
// publishWiki pushes the rebased commits to the wiki's branch after the code
// merges and deletes the wiki remote's agent/issue-<n>. A conflict leaves the
// rebase stopped for the conflict resolver; nothing is ever saved as a patch.
// No wiki, or no commits of the issue's own, means there is nothing to do.

import fs from "node:fs";
import path from "node:path";
import type { Config, WikiSettings } from "./config.ts";
import { paths, wikiCfg } from "./config.ts";
import { head } from "./git-state.ts";
import { git } from "./github.ts";
import { withWikiLock } from "./locks.ts";
import { OpsError, run } from "./process.ts";
import {
  abortRebase,
  rebaseInProgress,
  rebaseProblem,
  unmergedFiles,
} from "./rebase.ts";
import { pushWikiBranch, wikiAhead } from "./wiki.ts";

const PUBLISH_ATTEMPTS = 3;

// A rebase stopped in the wiki checkout, onto `origin/<branch>` at `baseSha`.
interface WikiConflict {
  conflict: true;
  inRebase: true;
  conflicts: string[];
  baseSha: string;
  branch: string;
}

type WikiSyncReply =
  | { conflict: false; changed: boolean; headSha: string }
  | WikiConflict;

type WikiFinishReply =
  | { resolved: false; reason: string }
  | { resolved: true; headSha: string };

type WikiPublish =
  | { published: true; sha: string | null }
  | ({ published: false } & WikiConflict);

interface Checkout {
  wiki: WikiSettings;
  dir: string;
}

const NOTHING: WikiSyncReply = { conflict: false, changed: false, headSha: "" };

// The issue's wiki checkout, or null when there is none.
function checkoutOf(cfg: Config, n: number): Checkout | null {
  const wiki = wikiCfg(cfg);
  const dir = paths.wiki(cfg, n);
  if (wiki === null || !fs.existsSync(path.join(dir, ".git"))) {
    return null;
  }
  return { wiki, dir };
}

// Drops a rebase left over from a crashed run and fetches the wiki's branch.
function freshen(cfg: Config, { wiki, dir }: Checkout): void {
  abortRebase(dir);
  const refspec = `+refs/heads/${wiki.branch}:refs/remotes/origin/${wiki.branch}`;
  git(cfg, ["-C", dir, "fetch", "origin", refspec]);
}

// Rebases the checkout onto the wiki's branch as last fetched. Null when it
// rebased cleanly; the stopped rebase's conflict otherwise.
function rebaseOnto({ wiki, dir }: Checkout): WikiConflict | null {
  const base = `origin/${wiki.branch}`;
  const rebased = run("git", ["-C", dir, "rebase", base], { allowFail: true });
  if (rebased.code === 0) {
    return null;
  }
  const baseSha = run("git", ["-C", dir, "rev-parse", base]).stdout.trim();
  if (!rebaseInProgress(dir)) {
    throw new OpsError(`the wiki rebase failed: ${rebased.stderr.trim()}`);
  }
  return {
    conflict: true,
    inRebase: true,
    conflicts: unmergedFiles(dir),
    baseSha,
    branch: wiki.branch,
  };
}

// Before the code merges: rebase the issue's wiki commits onto the wiki's
// latest version and keep the result on the wiki remote's agent/issue-<n>.
function syncWiki(cfg: Config, n: number): WikiSyncReply {
  const checkout = checkoutOf(cfg, n);
  if (checkout === null) {
    return NOTHING;
  }
  return withWikiLock(cfg, () => {
    freshen(cfg, checkout);
    if (wikiAhead(cfg, n) === 0) {
      return NOTHING;
    }
    const before = head(checkout.dir);
    const conflict = rebaseOnto(checkout);
    if (conflict !== null) {
      return conflict;
    }
    const headSha = head(checkout.dir);
    const changed = headSha !== before;
    if (changed) {
      pushWikiBranch(cfg, n);
    }
    return { conflict: false, changed, headSha };
  });
}

// Puts the checkout back on the wiki remote's agent/issue-<n>, dropping a
// half-done rebase.
function resetToWikiBranch(cfg: Config, { dir }: Checkout, n: number): void {
  abortRebase(dir);
  const branch = paths.branch(n);
  const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  git(cfg, ["-C", dir, "fetch", "origin", refspec], { allowFail: true });
  const ref = `refs/remotes/origin/${branch}`;
  const verify = ["-C", dir, "rev-parse", "--verify", "--quiet", ref];
  if (run("git", verify, { allowFail: true }).code === 0) {
    run("git", ["-C", dir, "reset", "--hard", ref]);
  }
  run("git", ["-C", dir, "clean", "-fd"]);
}

// After a writer resolved a stopped wiki rebase: keep it if it passes the
// checks. Anything else, or `abort`, resets the checkout and says why.
function finishWikiSync(
  cfg: Config,
  n: number,
  abort: string | null,
): WikiFinishReply {
  const checkout = checkoutOf(cfg, n);
  if (checkout === null) {
    return { resolved: false, reason: "the issue has no wiki checkout" };
  }
  return withWikiLock(cfg, () => {
    const base = `origin/${checkout.wiki.branch}`;
    const reason = abort ?? rebaseProblem(checkout.dir, base);
    if (reason !== undefined) {
      resetToWikiBranch(cfg, checkout, n);
      return { resolved: false, reason };
    }
    pushWikiBranch(cfg, n);
    return { resolved: true, headSha: head(checkout.dir) };
  });
}

// Deletes the wiki remote's agent/issue-<n>, when it exists.
function deleteWikiBranch(cfg: Config, dir: string, n: number): void {
  const branch = paths.branch(n);
  const listed = ["-C", dir, "ls-remote", "--exit-code", "--heads", "origin"];
  if (git(cfg, [...listed, branch], { allowFail: true }).code === 0) {
    git(cfg, ["-C", dir, "push", "origin", "--delete", branch]);
  }
}

// Rebases and pushes to the wiki's branch, retrying a lost push race. Returns
// the pushed head, null with nothing to push, or the conflict.
function pushRebased(
  cfg: Config,
  n: number,
  checkout: Checkout,
): string | null | WikiConflict {
  const target = `HEAD:refs/heads/${checkout.wiki.branch}`;
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
    freshen(cfg, checkout);
    const conflict = rebaseOnto(checkout);
    if (conflict !== null) {
      return conflict;
    }
    if (wikiAhead(cfg, n) === 0) {
      return null;
    }
    const push = ["-C", checkout.dir, "push", "origin", target];
    if (git(cfg, push, { allowFail: true }).code === 0) {
      return head(checkout.dir);
    }
  }
  throw new OpsError(
    `could not push the wiki changes after ${PUBLISH_ATTEMPTS} attempts`,
  );
}

// After the code merges: publish the issue's wiki commits on the wiki's
// branch and delete the wiki remote's agent/issue-<n>. A conflict leaves the
// rebase stopped; a push that keeps losing races throws.
function publishWiki(cfg: Config, n: number): WikiPublish {
  const checkout = checkoutOf(cfg, n);
  if (checkout === null) {
    return { published: true, sha: null };
  }
  return withWikiLock(cfg, () => {
    const pushed = pushRebased(cfg, n, checkout);
    if (typeof pushed === "object" && pushed !== null) {
      return { published: false, ...pushed };
    }
    deleteWikiBranch(cfg, checkout.dir, n);
    return { published: true, sha: pushed };
  });
}

export type { WikiConflict, WikiFinishReply, WikiPublish, WikiSyncReply };
export { finishWikiSync, publishWiki, syncWiki };
