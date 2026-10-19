// Fresh remote observations, separate from preserved historical claims. All
// source-branch PR states are inspected, including a closed or merged anchor.
import { z } from "zod";
import { assertOrigin, remoteRef, wikiOrigin } from "./adoption-origin.ts";
import type { AdoptionRequest } from "./adoption-plan.ts";
import { gitText } from "./adoption-preservation.ts";
import { isLegacyPipelineComment, isStateBody } from "./comment-marks.ts";
import type { IssueComment } from "./comments.ts";
import type { Config } from "./config.ts";
import { paths, wikiCfg, withCheckout } from "./config.ts";
import { ghJson } from "./github.ts";
import { branchRefusalOf } from "./job/branch.ts";
import { historicalPrFor } from "./ops/prs.ts";
import { OpsError } from "./ops-error.ts";
import { rawStateBody } from "./saved-state.ts";
import { CLAIM_LEGACY_STATE } from "./saved-state-legacy.ts";
import { FLOWS } from "./state.ts";

const SHA = z.string().regex(/^[a-f0-9]{40}$/u);
const LEGACY = z.looseObject({
  version: z.literal(1),
  number: z.number().int().positive(),
  stage: CLAIM_LEGACY_STATE.shape.stage,
  headSha: SHA.nullish(),
  pr: z.number().int().positive().nullish(),
  flows: FLOWS.nullish(),
  branch: z.string().min(1).nullish(),
  repo: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional(),
});
const REPO = z.object({ full_name: z.string() });
const ISSUE = z.object({
  number: z.number(),
  repository_url: z.string(),
  pull_request: z.never().optional(),
});
const REF = z.object({ ref: z.string(), sha: SHA, repo: REPO });
const PR = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  merged_at: z.iso.datetime().nullable(),
  merge_commit_sha: SHA.nullable(),
  head: REF,
  base: REF,
});
const TRUTH = z.object({
  repo: z.string(),
  issue: z.number(),
  branch: z.string(),
  base: z.string(),
  baseHead: SHA,
  head: SHA.nullable(),
  pr: z.number().nullable(),
  prState: z.enum(["OPEN", "CLOSED", "MERGED"]).nullable(),
  prHead: SHA.nullable(),
  merge: SHA.nullable(),
  wiki: z
    .object({
      origin: z.string(),
      branch: z.string(),
      head: SHA,
      published: SHA,
      privateHead: SHA.nullable(),
    })
    .nullable(),
});
type Truth = z.infer<typeof TRUTH>;

function validateLegacy(
  cfg: Config,
  request: AdoptionRequest,
  comments: readonly IssueComment[],
): number | null {
  const { issue, branch } = request;
  const historical = comments.filter(
    (item) =>
      isStateBody(item.body ?? "") &&
      (isLegacyPipelineComment(cfg, item) ||
        item.user?.login.toLowerCase() === cfg.mergeAccount.toLowerCase()),
  );
  const legacy = historical.map((item) =>
    LEGACY.parse(rawStateBody(item.body ?? "")),
  );
  if (legacy.length === 0) {
    throw new OpsError(
      "no identifiable retained version-1 state; explicit manual reconciliation needed",
    );
  }
  const retainedPrs = new Set<number>();
  for (const state of legacy) {
    if (state.pr !== undefined && state.pr !== null) {
      retainedPrs.add(state.pr);
    }
    validateLegacyWork(cfg, request, state);
    if (
      state.number !== issue ||
      (state.repo !== undefined &&
        state.repo.toLowerCase() !== cfg.repo.toLowerCase()) ||
      (state.baseBranch !== undefined && state.baseBranch !== cfg.baseBranch) ||
      (state.branch ?? paths.legacyBranch(issue)) !== branch
    ) {
      throw new OpsError(
        "legacy repository, issue, source or target identity mismatch",
      );
    }
  }
  if (retainedPrs.size > 1) {
    throw new OpsError(
      "conflicting retained PR identities require explicit reconciliation",
    );
  }
  const [retainedPr] = retainedPrs;
  return retainedPr ?? null;
}

function validateLegacyWork(
  cfg: Config,
  request: AdoptionRequest,
  state: z.infer<typeof LEGACY>,
): void {
  if (state.headSha !== undefined && state.headSha !== null) {
    gitText(request.code, [
      "merge-base",
      "--is-ancestor",
      state.headSha,
      "HEAD",
    ]);
  }
  if (state.flows?.wiki === true && wikiCfg(cfg) === null) {
    throw new OpsError(
      "retained wiki flow lacks configured wiki identity; preserve/select its checkout explicitly",
    );
  }
}

function inspectTruth(
  cfg: Config,
  request: AdoptionRequest,
  legacyPr: number | null,
): Truth {
  const { issue, branch, code } = request;
  const bound = withCheckout(cfg, { issue, dir: code, branch });
  const refusal = branchRefusalOf(cfg, issue, branch, true);
  if (refusal !== null) {
    throw new OpsError(refusal);
  }
  const repo = REPO.parse(ghJson(cfg, "merge", ["api", `repos/${cfg.repo}`]));
  const actualIssue = ISSUE.parse(
    ghJson(cfg, "merge", ["api", `repos/${cfg.repo}/issues/${issue}`]),
  );
  if (
    repo.full_name.toLowerCase() !== cfg.repo.toLowerCase() ||
    actualIssue.number !== issue ||
    actualIssue.repository_url.toLowerCase() !==
      `https://api.github.com/repos/${cfg.repo}`.toLowerCase()
  ) {
    throw new OpsError("actual repository or issue identity mismatch");
  }
  const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
  assertOrigin(code, url);
  if (
    gitText(code, ["rev-parse", "--show-prefix"]) !== "" ||
    gitText(code, ["symbolic-ref", "--short", "HEAD"]) !== branch
  ) {
    throw new OpsError(
      "selected code checkout is not on the proposed source branch",
    );
  }
  const head = remoteRef(cfg, url, branch);
  const baseHead = remoteRef(cfg, url, cfg.baseBranch);
  if (baseHead === null) {
    throw new OpsError("configured target branch is absent");
  }
  const pr = historicalPrFor(bound, issue);
  if (legacyPr !== null && legacyPr !== pr) {
    throw new OpsError(
      "retained PR identity is absent from all-state source history",
    );
  }
  const { prState, prHead, merge } = inspectPr(cfg, { pr, branch, head });
  if (head === null && prState !== "MERGED") {
    throw new OpsError("source branch is missing; manual recovery needed");
  }
  const wikiTruth = inspectWiki(cfg, request);
  return {
    repo: cfg.repo,
    issue,
    branch,
    base: cfg.baseBranch,
    baseHead,
    head,
    pr,
    prState,
    prHead,
    merge,
    wiki: wikiTruth,
  };
}

function inspectPr(
  cfg: Config,
  selection: { pr: number | null; branch: string; head: string | null },
): Pick<Truth, "prState" | "prHead" | "merge"> {
  let prState: Truth["prState"] = null;
  let prHead: string | null = null;
  let merge: string | null = null;
  const { pr, branch, head } = selection;
  if (pr !== null) {
    const actual = PR.parse(
      ghJson(cfg, "merge", ["api", `repos/${cfg.repo}/pulls/${pr}`]),
    );
    if (
      actual.number !== pr ||
      actual.head.ref !== branch ||
      actual.base.ref !== cfg.baseBranch ||
      actual.head.repo.full_name.toLowerCase() !== cfg.repo.toLowerCase() ||
      actual.base.repo.full_name.toLowerCase() !== cfg.repo.toLowerCase()
    ) {
      throw new OpsError(
        "retained PR repository, source or target identity mismatch",
      );
    }
    prHead = actual.head.sha;
    prState = "OPEN";
    if (actual.state === "closed") {
      prState = "CLOSED";
    }
    ({ prState, merge } = mergeTruth(actual));
    if (head !== null && head !== prHead) {
      throw new OpsError("actual source head differs from retained PR head");
    }
  }
  return { prState, prHead, merge };
}

function mergeTruth(
  actual: z.infer<typeof PR>,
): Pick<Truth, "prState" | "merge"> {
  let prState: Truth["prState"] = "OPEN";
  let merge: string | null = null;
  if (actual.state === "closed") {
    prState = "CLOSED";
  }
  if (actual.merged) {
    if (
      actual.state !== "closed" ||
      actual.merged_at === null ||
      actual.merge_commit_sha === null
    ) {
      throw new OpsError("unverifiable PR merge evidence");
    }
    prState = "MERGED";
    merge = actual.merge_commit_sha;
    // Fetch only into an isolated evidence repo, never into retained work.
  } else if (actual.merged_at !== null) {
    throw new OpsError("inconsistent PR merge evidence");
  }
  return { prState, merge };
}

function inspectWiki(cfg: Config, request: AdoptionRequest): Truth["wiki"] {
  const { branch, wiki, code } = request;
  const settings = wikiCfg(cfg);
  let wikiTruth: Truth["wiki"] = null;
  if (settings !== null) {
    if (wiki === undefined) {
      throw new OpsError(
        "configured wiki requires an explicit --wiki-path and preserved wiki work",
      );
    }
    const wikiUrl = wikiOrigin(cfg, code);
    assertOrigin(wiki, wikiUrl);
    const published = remoteRef(cfg, wikiUrl, settings.branch);
    if (
      published === null ||
      gitText(wiki, ["symbolic-ref", "--short", "HEAD"]) !== branch
    ) {
      throw new OpsError("wiki identity or published branch is unresolved");
    }
    wikiTruth = {
      origin: wikiUrl,
      branch,
      head: SHA.parse(gitText(wiki, ["rev-parse", "HEAD"])),
      published,
      privateHead: remoteRef(cfg, wikiUrl, branch),
    };
  } else if (wiki !== undefined) {
    throw new OpsError("wiki work selected but no configured wiki identity");
  }
  return wikiTruth;
}

export type { Truth };
export { inspectTruth, TRUTH, validateLegacy };
