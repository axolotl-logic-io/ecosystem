// prepare-review: the diff and bundle a review round reads. Before the code
// merges, they hold the branch's code change since the last reviewed head
// that is still in its history, then the whole wiki change. Once the code
// merged, they hold the merge commit GitHub confirmed, as its change against
// its first parent, then the whole wiki change, with the checkout detached
// at the merge commit (merged-review.ts).

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { fetchIn, head, patchIdOf } from "../git-state.ts";
import { parseRequest, run } from "../process.ts";
import type { CodeMerged } from "../state.ts";
import { mergedCode } from "./merged-review.ts";
import { commitLog, reviewBundle, withWiki } from "./review-diff.ts";

// headTree is the head's tree, the same for any head with the same code.
// patchId is the id of the branch's changes, which a clean rebase keeps, or
// null when there are none (review-keeps-on-clean-rebase). bundlePath is the
// review bundle beside the diff: the diff, then the changed files' head texts;
// bundleText is its text, so a review's tasks can hold it without reading the
// file back (#421).
interface ReviewReply {
  headSha: string;
  headTree: string;
  baseSha: string;
  patchId: string | null;
  diffPath: string;
  diffLines: number;
  changedFiles: string[];
  bundlePath: string;
  bundleLines: number;
  bundleText: string;
}
const REVIEW_REQUEST = z.looseObject({
  number: z.number().int(),
  sinceSha: z.string().nullish(),
  tag: z.string().nullish(),
  // The merged PR and its merge commit, once the code merged.
  codeMerged: z
    .object({ pr: z.number().int().positive(), sha: z.string().min(1) })
    .nullish(),
});
function present(text: string | null | undefined): text is string {
  return text !== undefined && text !== null && text !== "";
}

// `text`, or `fallback` when it is missing or empty.
function textOr(text: string | null | undefined, fallback: string): string {
  if (present(text)) {
    return text;
  }
  return fallback;
}

function gitOut(wt: string, args: readonly string[]): string {
  return run("git", ["-C", wt, ...args]).stdout;
}

function gitSucceeds(wt: string, args: readonly string[]): boolean {
  return run("git", ["-C", wt, ...args], { allowFail: true }).code === 0;
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

// A sync rebases the branch, so an earlier reviewed commit may no longer be in its
// history. Diffing from it would then show everything the base gained since, so
// review the whole branch instead.
function reviewFrom(
  wt: string,
  sinceSha: string | null | undefined,
  { headSha, baseSha }: { headSha: string; baseSha: string },
): string {
  if (!present(sinceSha)) {
    return baseSha;
  }
  if (gitSucceeds(wt, ["merge-base", "--is-ancestor", sinceSha, headSha])) {
    return sinceSha;
  }
  return baseSha;
}

// The review's diff and bundle for `range`, written to the round's folder.
// The diff is `diff` with the whole wiki change after it.
function writeReview(
  cfg: Config,
  n: number,
  {
    tag,
    diff,
    range,
  }: { tag: string; diff: string; range: { from: string; head: string } },
): Pick<
  ReviewReply,
  "diffPath" | "diffLines" | "bundlePath" | "bundleLines" | "bundleText"
> & { wikiFiles: string[] } {
  const wt = paths.worktree(cfg, n);
  const dir = path.join(paths.runDir(cfg, n), `review-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  const diffPath = path.join(dir, "diff.patch");
  const full = withWiki(cfg, n, diff);
  fs.writeFileSync(diffPath, full.text);
  const bundlePath = path.join(dir, "bundle.md");
  const bundle = reviewBundle(wt, range, full.text);
  fs.writeFileSync(bundlePath, bundle);
  return {
    diffPath,
    diffLines: full.text.split("\n").length,
    bundlePath,
    bundleLines: bundle.split("\n").length,
    bundleText: bundle,
    wikiFiles: full.files,
  };
}

// The review of the merged result after the code merged as
// `codeMerged.sha`, once GitHub confirms that merge (merged-review.ts): the
// merge commit's change against its first parent, then the whole wiki
// change, with the bundle holding the merged files' texts.
function prepareMergedReview(
  cfg: Config,
  n: number,
  { tag, codeMerged }: { tag: string; codeMerged: CodeMerged },
): ReviewReply {
  const merged = mergedCode(cfg, n, codeMerged);
  const { wikiFiles, ...written } = writeReview(cfg, n, {
    tag,
    diff: merged.diff,
    range: merged.range,
  });
  return {
    headSha: codeMerged.sha,
    headTree: merged.tree,
    baseSha: merged.parent,
    patchId: null,
    changedFiles: merged.files.concat(wikiFiles),
    ...written,
  };
}

function prepareReview(cfg: Config, request: unknown): ReviewReply {
  const req = parseRequest(REVIEW_REQUEST, "prepare-review", request);
  const n = req.number;
  const tag = textOr(req.tag, "r0");
  if (req.codeMerged !== null && req.codeMerged !== undefined) {
    return prepareMergedReview(cfg, n, { tag, codeMerged: req.codeMerged });
  }
  const wt = paths.worktree(cfg, n);
  fetchIn(cfg, wt, cfg.baseBranch);
  const headSha = head(wt);
  const headTree = gitOut(wt, ["rev-parse", `${headSha}^{tree}`]).trim();
  const measured = `origin/${cfg.baseBranch}`;
  const baseSha = gitOut(wt, ["merge-base", measured, "HEAD"]).trim();
  const from = reviewFrom(wt, req.sinceSha, { headSha, baseSha });
  const range = `${from}..${headSha}`;
  const patch = gitOut(wt, ["diff", "--stat", "--patch", range]);
  const diff = `${commitLog(wt, range)}${patch}`;
  const names = gitOut(wt, ["diff", "--name-only", `${baseSha}..${headSha}`]);
  const { wikiFiles, ...written } = writeReview(cfg, n, {
    tag,
    diff,
    range: { from, head: headSha },
  });
  return {
    headSha,
    headTree,
    baseSha,
    patchId: patchIdOf(wt, measured, headSha),
    changedFiles: nonEmptyLines(names).concat(wikiFiles),
    ...written,
  };
}

export type { ReviewReply };
export { prepareReview };
