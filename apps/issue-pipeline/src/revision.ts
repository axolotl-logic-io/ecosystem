// The issue's PR as GitHub reports it, and the issue's current revision: the
// code head and the trusted-inputs revision a review or a Land binds to. GitHub is the only authority on whether the code
// landed: nothing here infers a Land, and a PR GitHub can't confirm is from
// the issue's own branch, in the configured repo, is refused.

import { z } from "zod";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { ghJson } from "./github.ts";
import { OpsError } from "./ops-error.ts";
import { assertPrBase } from "./pr-authority.ts";

const PR_FIELDS =
  "number,state,mergeCommit,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,mergeable";
const MERGEABLE = z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);

const PR_VIEW = z.looseObject({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergeCommit: z.looseObject({ oid: z.string() }).nullish(),
  headRefName: z.string(),
  headRefOid: z.string().min(1),
  baseRefName: z.string(),
  isCrossRepository: z.boolean(),
  isDraft: z.boolean(),
  mergeable: MERGEABLE,
});

// The issue's PR as GitHub reports it: a merged PR's merge commit, null
// otherwise, and its head commit, which GitHub keeps after the branch is
// deleted; whether it is a draft, and whether GitHub can merge its head
// into its base (UNKNOWN while GitHub is still computing it).
interface PullRequest {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeCommit: string | null;
  headSha: string;
  draft: boolean;
  mergeable: z.infer<typeof MERGEABLE>;
}

// PR `pr` of issue `n` as GitHub reports it. A PR from another branch or
// repo, one targeting another base, and a merged PR with no merge commit
// are refused; a failed read throws, so a Land is never assumed.
function pullRequest(cfg: Config, n: number, pr: number): PullRequest {
  const view = PR_VIEW.safeParse(
    ghJson(cfg, "landing", [
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
    if (data.mergeCommit !== null && data.mergeCommit !== undefined) {
      throw new OpsError(`PR #${pr} has inconsistent merge evidence`);
    }
    return {
      number: pr,
      state: data.state,
      mergeCommit: null,
      headSha: data.headRefOid,
      draft: data.isDraft,
      mergeable: data.mergeable,
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
    draft: data.isDraft,
    mergeable: data.mergeable,
  };
}

export type { PullRequest };
export { pullRequest };
