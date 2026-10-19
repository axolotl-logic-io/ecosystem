// Bringing an issue's wiki commits onto the wiki's latest version before the
// review that approves them. syncWiki rebases the issue's wiki checkout onto
// the wiki's branch and finishWikiSync checks and keeps a rebase a writer
// resolved. A conflict leaves the rebase stopped for the conflict resolver;
// rejected resolution work is preserved before cleanup. No wiki, or no
// commits of the issue's own, means there is nothing to do. Publishing the approved wiki is
// wiki-publication.ts's, and never rebases.

import fs from "node:fs";
import path from "node:path";
import type { Config, WikiSettings } from "./config.ts";
import { paths, wikiCfg } from "./config.ts";
import { head } from "./git-state.ts";
import { git } from "./github.ts";
import { saveSyncRecovery } from "./job/code-recovery.ts";
import { withWikiLock } from "./locks.ts";
import { OpsError } from "./ops-error.ts";
import { run } from "./process.ts";
import {
  abortRebase,
  rebaseInProgress,
  rebaseProblem,
  unmergedFiles,
} from "./rebase.ts";
import { pushWikiBranch, wikiAhead } from "./wiki.ts";

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
function freshen(cfg: Config, { wiki, dir }: Checkout, n: number): void {
  if (rebaseInProgress(dir)) {
    saveSyncRecovery(cfg, n, dir);
    abortRebase(dir);
  }
  const refspec = `+refs/heads/${wiki.branch}:refs/remotes/origin/${wiki.branch}`;
  git(cfg, "merge", ["-C", dir, "fetch", "origin", refspec]);
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
    freshen(cfg, checkout, n);
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

// Returns to the pre-rebase head, not an older remote issue branch. Failed
// preparation retains the original checkout; evidence never authorizes a push.
function restoreBeforeRebase(cfg: Config, { dir }: Checkout, n: number): void {
  saveSyncRecovery(cfg, n, dir);
  const original = run("git", [
    "-C",
    dir,
    "rev-parse",
    "--verify",
    "ORIG_HEAD",
  ]).stdout.trim();
  abortRebase(dir);
  run("git", ["-C", dir, "reset", "--hard", original]);
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
      restoreBeforeRebase(cfg, checkout, n);
      return { resolved: false, reason };
    }
    pushWikiBranch(cfg, n);
    return { resolved: true, headSha: head(checkout.dir) };
  });
}

// Deletes the wiki remote's agent/issue-<n>, when it exists.
function deleteWikiBranch(cfg: Config, dir: string, n: number): void {
  const branch = paths.branch(cfg, n);
  const listed = ["-C", dir, "ls-remote", "--exit-code", "--heads", "origin"];
  if (git(cfg, "merge", [...listed, branch], { allowFail: true }).code === 0) {
    git(cfg, "merge", ["-C", dir, "push", "origin", "--delete", branch]);
  }
}

export type { Checkout, WikiConflict, WikiFinishReply, WikiSyncReply };
export { checkoutOf, deleteWikiBranch, finishWikiSync, syncWiki };
