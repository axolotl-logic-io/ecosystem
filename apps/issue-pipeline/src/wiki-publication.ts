// Publishing the wiki head a review approved, and proving it was published.
// publishReviewedWiki fast-forwards the wiki's branch to exactly the
// approved head, never rebasing, resetting or aborting anything
// (`exact-reviewed-wiki`); confirmWikiPublished proves a recorded wiki commit
// is on the wiki before finish-wiki closes the issue.

import type { Config } from "./config.ts";
import { gitIn, head } from "./git-state.ts";
import { git } from "./github.ts";
import { withWikiLock } from "./locks.ts";
import { OpsError, run } from "./process.ts";
import { rebaseInProgress } from "./rebase.ts";
import { wikiAhead } from "./wiki.ts";
import type { Checkout } from "./wiki-publish.ts";
import { checkoutOf, deleteWikiBranch } from "./wiki-publish.ts";

// Why a publish refused: the checkout no longer holds the approved head
// (stale), the wiki moved past it (wiki-behind), or the checkout is mid-rebase
// or dirty (wiki-unclean).
interface WikiRefusal {
  published: false;
  reason: "stale" | "wiki-behind" | "wiki-unclean";
  detail: string;
}

// A publish: the wiki's new head and the commits it added ("<short sha>
// <subject>", oldest first), with alreadyPublished when the wiki already held
// that head, or why it refused.
type WikiPublish =
  | {
      published: true;
      sha: string | null;
      commits: string[];
      alreadyPublished: boolean;
    }
  | WikiRefusal;

type WikiPublication =
  | { published: true }
  | {
      published: false;
      reason: "wiki-unpublished" | "wiki-changed";
      detail: string;
    };

// Whether `descendant` contains `ancestor`; false when either is missing.
function isAncestor(
  dir: string,
  ancestor: string,
  descendant: string,
): boolean {
  const args = ["-C", dir, "merge-base", "--is-ancestor", ancestor, descendant];
  return run("git", args, { allowFail: true }).code === 0;
}

// Fetches the wiki's branch without touching the checkout.
function fetchWikiBranch(cfg: Config, { wiki, dir }: Checkout): string {
  const refspec = `+refs/heads/${wiki.branch}:refs/remotes/origin/${wiki.branch}`;
  git(cfg, ["-C", dir, "fetch", "origin", refspec]);
  return `origin/${wiki.branch}`;
}

function uncleanWiki(dir: string): boolean {
  return (
    rebaseInProgress(dir) || gitIn(dir, ["status", "--porcelain"]).trim() !== ""
  );
}

function wikiRefusal(
  reason: WikiRefusal["reason"],
  detail: string,
): WikiRefusal {
  return { published: false, reason, detail };
}

const NOTHING_PUBLISHED: WikiPublish = {
  published: true,
  sha: null,
  commits: [],
  alreadyPublished: false,
};

function publishLocked(
  cfg: Config,
  n: number,
  checkout: Checkout,
  expectedWiki: string | null,
): WikiPublish {
  const { dir } = checkout;
  if (uncleanWiki(dir)) {
    return wikiRefusal(
      "wiki-unclean",
      "the wiki checkout has a rebase in progress or uncommitted changes",
    );
  }
  const base = fetchWikiBranch(cfg, checkout);
  const headSha = head(dir);
  if (expectedWiki === null) {
    if (wikiAhead(cfg, n) > 0) {
      return wikiRefusal(
        "stale",
        `the wiki checkout has commits up to ${headSha} that the approved revision does not`,
      );
    }
    return NOTHING_PUBLISHED;
  }
  if (headSha !== expectedWiki) {
    return wikiRefusal(
      "stale",
      `the wiki checkout is at ${headSha}, not the approved ${expectedWiki}`,
    );
  }
  if (isAncestor(dir, expectedWiki, base)) {
    deleteWikiBranch(cfg, dir, n);
    return {
      published: true,
      sha: expectedWiki,
      commits: [],
      alreadyPublished: true,
    };
  }
  if (!isAncestor(dir, base, expectedWiki)) {
    return wikiRefusal(
      "wiki-behind",
      `${base} moved past the approved wiki commit ${expectedWiki}; publishing it now would need an unreviewed rebase`,
    );
  }
  return pushReviewed(cfg, n, checkout, { base, expectedWiki });
}

// Pushes `expectedWiki`, which fast-forwards `base`, to the wiki's branch.
// A failed push that left the wiki holding it still published; one the wiki
// moved past refuses; any other failure throws with git's own text.
function pushReviewed(
  cfg: Config,
  n: number,
  checkout: Checkout,
  { base, expectedWiki }: { base: string; expectedWiki: string },
): WikiPublish {
  const { wiki, dir } = checkout;
  const range = `${base}..${expectedWiki}`;
  const log = ["log", "--reverse", "--abbrev=12", "--format=%h %s", range];
  const commits = gitIn(dir, log).trim().split("\n");
  // No force: the wiki's branch only ever fast-forwards to the reviewed head.
  const target = `${expectedWiki}:refs/heads/${wiki.branch}`;
  const pushed = git(cfg, ["-C", dir, "push", "origin", target], {
    allowFail: true,
  });
  if (pushed.code !== 0) {
    const after = fetchWikiBranch(cfg, checkout);
    if (!isAncestor(dir, expectedWiki, after)) {
      if (!isAncestor(dir, after, expectedWiki)) {
        return wikiRefusal(
          "wiki-behind",
          `${after} moved while publishing ${expectedWiki}: ${pushed.stderr.trim()}`,
        );
      }
      throw new OpsError(
        `the wiki push of ${expectedWiki} failed: ${pushed.stderr.trim()}`,
      );
    }
  }
  deleteWikiBranch(cfg, dir, n);
  return {
    published: true,
    sha: expectedWiki,
    commits,
    alreadyPublished: false,
  };
}

// After the code merged (or for a change that lives only in the wiki):
// fast-forward the wiki's branch to exactly `expectedWiki`, the wiki head the
// review approved, and delete the wiki remote's agent/issue-<n>. It never
// rebases: a wiki that moved past the approved head, or a checkout that no
// longer holds it, is refused for a new sync and review. `expectedWiki` null
// means the approved revision has no wiki commits, so nothing may be ahead.
// Publishing a head the wiki already contains succeeds again, so a retry
// after a crash is safe.
function publishReviewedWiki(
  cfg: Config,
  n: number,
  expectedWiki: string | null,
): WikiPublish {
  const checkout = checkoutOf(cfg, n);
  if (checkout === null) {
    if (expectedWiki === null) {
      return NOTHING_PUBLISHED;
    }
    throw new OpsError(
      `cannot publish wiki commit ${expectedWiki} of #${n}: the issue has no wiki checkout`,
    );
  }
  return withWikiLock(cfg, () => publishLocked(cfg, n, checkout, expectedWiki));
}

// Whether the wiki's branch holds the recorded wiki commit `sha` and the
// issue's wiki checkout has nothing past it, which is the proof finish-wiki
// needs before it closes the issue. The checkout may sit at `sha`, or at the
// wiki's branch once the publish deleted agent/issue-<n>. On proof it deletes
// the wiki remote's agent/issue-<n>, if still there.
function confirmWikiPublished(
  cfg: Config,
  n: number,
  sha: string,
): WikiPublication {
  const checkout = checkoutOf(cfg, n);
  if (checkout === null) {
    throw new OpsError(
      `cannot confirm wiki commit ${sha} of #${n} is published: the issue has no wiki checkout`,
    );
  }
  return withWikiLock(cfg, () => {
    const base = fetchWikiBranch(cfg, checkout);
    if (!isAncestor(checkout.dir, sha, base)) {
      return {
        published: false,
        reason: "wiki-unpublished",
        detail: `${base} does not contain the recorded wiki commit ${sha}`,
      };
    }
    const changed =
      uncleanWiki(checkout.dir) ||
      (head(checkout.dir) !== sha && wikiAhead(cfg, n) > 0);
    if (changed) {
      return {
        published: false,
        reason: "wiki-changed",
        detail: `the wiki checkout has changes past the published ${sha}`,
      };
    }
    deleteWikiBranch(cfg, checkout.dir, n);
    return { published: true };
  });
}

export type { WikiPublication, WikiPublish, WikiRefusal };
export { confirmWikiPublished, publishReviewedWiki };
