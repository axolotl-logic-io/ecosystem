// The complete delivered-change boundary, derived from fetched immutable
// objects, never from an OPEN PR's test merge or the current base tip.
import { z } from "zod";
import type { Config } from "../config.ts";
import { gitIn } from "../git-state.ts";
import { OpsError } from "../ops-error.ts";
import { confirmMerged, pullRequest } from "../revision.ts";
import type { CodeMerged } from "../state.ts";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const FULL_SHA = z.string().regex(FULL_SHA_PATTERN);

// A unique original contribution cannot be inferred from criss-cross or
// already-landed source history, even with superficially ordered parents.
function confirmSourceHistory(
  wt: string,
  sha: string,
  parent: string,
  head: string,
): void {
  const bases = gitIn(wt, ["merge-base", "--all", parent, head])
    .trim()
    .split("\n");
  if (
    bases.length !== 1 ||
    bases[0] === head ||
    !FULL_SHA.safeParse(bases[0]).success
  ) {
    throw new OpsError(
      `unsupported merged result ${sha}: ambiguous or already-landed source history`,
    );
  }
}

// New branch merges must have ordered parents [integration-side, retained
// authorized head]. Legacy squash receipts are usable only when their entire
// first-parent delta equals the original head's entire delta.
function mergedParent(
  wt: string,
  sha: string,
  head: string,
  branchOnly = false,
): string {
  FULL_SHA.parse(sha);
  FULL_SHA.parse(head);
  const parents = gitIn(wt, ["show", "-s", "--format=%P", sha])
    .trim()
    .split(" ");
  const [parent, second] = parents;
  if (
    sha !== head &&
    parent !== undefined &&
    FULL_SHA.safeParse(parent).success
  ) {
    if (parents.length === 2 && second === head) {
      confirmSourceHistory(wt, sha, parent, head);
      return parent;
    }
    if (!branchOnly && parents.length === 1) {
      const ancestor = gitIn(wt, ["merge-base", parent, head]).trim();
      const args = [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--binary",
      ];
      const original = gitIn(wt, [...args, `${ancestor}..${head}`]);
      const delivered = gitIn(wt, [...args, `${parent}..${sha}`]);
      if (original !== "" && original === delivered) {
        return parent;
      }
    }
  }
  throw new OpsError(
    `unsupported merged result ${sha} for retained head ${head}: complete delivered-change coverage is not established (fast-forward results are unsupported)`,
  );
}

// Confirms genuine same-PR MERGED metadata and fresh integration ancestry,
// then establishes a complete first-parent range for checks/review/replay.
function confirmedMergedParent(
  cfg: Config,
  n: number,
  wt: string,
  codeMerged: CodeMerged,
): string {
  confirmMerged(cfg, n, { wt, codeMerged });
  const pr = pullRequest(cfg, n, codeMerged.pr);
  if (pr.state !== "MERGED" || pr.mergeCommit !== codeMerged.sha) {
    throw new OpsError(
      "the PR merge receipt changed while reading its retained head",
    );
  }
  return mergedParent(wt, codeMerged.sha, pr.headSha);
}

export { confirmedMergedParent, FULL_SHA, mergedParent };
