// The issue's PR as GitHub reports it, and the issue's current revision: the
// code head, the wiki head and the trusted-inputs revision a review, a merge
// or a publish binds to. GitHub is the only authority on whether the code
// merged: nothing here infers a merge, and a PR GitHub can't confirm is from
// the issue's own branch, in the configured repo, is refused.

import { z } from "zod";
import type { Config } from "./config.ts";
import { paths, wikiCfg } from "./config.ts";
import { fetchIn, gitIn, head, remoteHead } from "./git-state.ts";
import { ghJson } from "./github.ts";
import { trustedInputsHash, writeIssueContext } from "./issue-context.ts";
import { openPrFor } from "./ops/prs.ts";
import { assertPrBase } from "./pr-authority.ts";
import { OpsError, run } from "./process.ts";
import type { CodeMerged, IssueState, Revision } from "./state.ts";
import { wikiAhead } from "./wiki.ts";

const PR_FIELDS =
  "number,state,mergeCommit,headRefName,headRefOid,baseRefName,isCrossRepository";

const PR_VIEW = z.looseObject({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergeCommit: z.looseObject({ oid: z.string() }).nullish(),
  headRefName: z.string(),
  headRefOid: z.string().min(1),
  baseRefName: z.string(),
  isCrossRepository: z.boolean(),
});

// The issue's PR as GitHub reports it: a merged PR's merge commit, null
// otherwise, and its head commit, which GitHub keeps after the branch is
// deleted.
interface PullRequest {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeCommit: string | null;
  headSha: string;
}

// The current revision and what it was read from (`current-revision`).
interface CurrentRevision {
  revision: Revision;
  // The base branch's tip on GitHub, freshly fetched.
  baseSha: string;
  pr: PullRequest | null;
  // The code merge GitHub reports, by the claim's rule (codeMergedOf).
  codeMerged: CodeMerged | null;
  checkoutHead: string;
  remoteHead: string | null;
  issueFile: string;
}

// PR `pr` of issue `n` as GitHub reports it. A PR from another branch or
// repo, one targeting another base, and a merged PR with no merge commit
// are refused; a failed read throws, so a merge is never assumed.
function pullRequest(cfg: Config, n: number, pr: number): PullRequest {
  const view = PR_VIEW.safeParse(
    ghJson(cfg, [
      "pr",
      "view",
      String(pr),
      "-R",
      cfg.repo,
      "--json",
      PR_FIELDS,
    ]),
  );
  if (!view.success) {
    throw new OpsError(
      `GitHub's reply for PR #${pr} doesn't parse: ${z.prettifyError(view.error)}`,
    );
  }
  const { data } = view;
  const branch = paths.branch(cfg, n);
  if (
    data.number !== pr ||
    data.headRefName !== branch ||
    data.isCrossRepository
  ) {
    throw new OpsError(
      `PR #${pr} is not from ${cfg.repo}'s ${branch}, so it isn't #${n}'s PR`,
    );
  }
  assertPrBase(cfg, pr, data.baseRefName);
  if (data.state !== "MERGED") {
    return {
      number: pr,
      state: data.state,
      mergeCommit: null,
      headSha: data.headRefOid,
    };
  }
  const oid = data.mergeCommit?.oid ?? "";
  if (oid === "") {
    throw new OpsError(
      `PR #${pr} merged into ${data.baseRefName} with merge commit "${oid}"; the pipeline needs a merge commit on ${cfg.baseBranch}`,
    );
  }
  return {
    number: pr,
    state: "MERGED",
    mergeCommit: oid,
    headSha: data.headRefOid,
  };
}

// Confirms on GitHub that issue `n`'s PR `codeMerged.pr` merged as
// `codeMerged.sha`, and that the commit is on the base branch fetched into
// the worktree `wt`; throws otherwise, so a merge is never assumed.
function confirmMerged(
  cfg: Config,
  n: number,
  { wt, codeMerged }: { wt: string; codeMerged: CodeMerged },
): void {
  const { pr, sha } = codeMerged;
  const found = pullRequest(cfg, n, pr);
  if (found.state !== "MERGED" || found.mergeCommit !== sha) {
    throw new OpsError(
      `GitHub doesn't report PR #${pr} merged as ${sha} (${found.state}, merge commit ${found.mergeCommit ?? "none"})`,
    );
  }
  fetchIn(cfg, wt, cfg.baseBranch);
  const base = `origin/${cfg.baseBranch}`;
  const reachable = run(
    "git",
    ["-C", wt, "merge-base", "--is-ancestor", sha, base],
    { allowFail: true },
  );
  if (reachable.code !== 0) {
    throw new OpsError(`merge commit ${sha} is not on ${base}`);
  }
}

// The issue's PR: `state`'s, or else the open PR from the issue's branch;
// null when it has neither.
function issuePullRequest(
  cfg: Config,
  n: number,
  state: Pick<IssueState, "pr"> | null,
): PullRequest | null {
  const pr = state?.pr ?? openPrFor(cfg, n) ?? null;
  if (pr === null) {
    return null;
  }
  return pullRequest(cfg, n, pr);
}

// The code merge `pr` records, or null when it hasn't merged.
function codeMergedOf(pr: PullRequest | null): CodeMerged | null {
  if (pr === null || pr.mergeCommit === null) {
    return null;
  }
  return { pr: pr.number, sha: pr.mergeCommit };
}

// The issue's wiki head when its wiki checkout holds commits the wiki
// lacks, or null.
function wikiHead(cfg: Config, n: number): string | null {
  const dir = paths.wiki(cfg, n);
  const wiki = wikiCfg(cfg);
  if (wiki === null) {
    return null;
  }
  // A wiki checkout is a repo's top: inside the code checkout, an
  // uninitialized submodule's folder has a prefix.
  const checkout = run("git", ["-C", dir, "rev-parse", "--show-prefix"], {
    allowFail: true,
  });
  if (checkout.code !== 0 || checkout.stdout.trim() !== "") {
    return null;
  }
  fetchIn(cfg, dir, wiki.branch);
  if (wikiAhead(cfg, n) === 0) {
    return null;
  }
  return head(dir);
}

// Issue `n`'s current revision, read afresh: its trusted inputs from GitHub
// (rewriting the issue file), its PR from `state.pr` or its branch, its code
// head (the merge commit once GitHub says the PR merged, else the checkout's
// HEAD) and its wiki head.
function currentRevision(
  cfg: Config,
  n: number,
  state: Pick<IssueState, "pr"> | null,
): CurrentRevision {
  const context = writeIssueContext(cfg, n);
  const inputs = trustedInputsHash(cfg, context.issue, context.comments);
  const pr = issuePullRequest(cfg, n, state);
  const codeMerged = codeMergedOf(pr);
  const wt = paths.worktree(cfg, n);
  fetchIn(cfg, wt, cfg.baseBranch);
  const baseSha = gitIn(wt, ["rev-parse", `origin/${cfg.baseBranch}`]).trim();
  const checkoutHead = head(wt);
  return {
    revision: {
      code: codeMerged?.sha ?? checkoutHead,
      wiki: wikiHead(cfg, n),
      inputs,
    },
    baseSha,
    pr,
    codeMerged,
    checkoutHead,
    remoteHead: remoteHead(cfg, n),
    issueFile: context.file,
  };
}

export type { CurrentRevision, PullRequest };
export {
  codeMergedOf,
  confirmMerged,
  currentRevision,
  issuePullRequest,
  pullRequest,
};
