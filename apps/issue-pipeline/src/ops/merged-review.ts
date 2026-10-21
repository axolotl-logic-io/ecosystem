// The code a review reads once the issue's code merged: the merge commit
// GitHub confirmed, as its change against its first parent (the base it
// merged into), with the issue's checkout detached at that commit, so the
// files a review opens there are the merged result, not the branch's. It
// fails closed: an unconfirmed merge, a merge commit with no first parent or
// no change against it, a checkout with uncommitted changes, or a checkout
// that doesn't end at exactly the merge commit's tree throws, before
// anything is written. Nothing here pushes, saves or moves a branch: the
// merge commit is on the base on GitHub, so a detached HEAD at it is no
// unpushed work.

import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { gitIn, head } from "../git-state.ts";
import { OpsError } from "../ops-error.ts";
import { tail } from "../process.ts";
import type { CodeMerged } from "../state.ts";
import { confirmedMergedParent } from "./merged-graph.ts";
import { commitLog } from "./review-diff.ts";

// How many status lines a dirty-checkout refusal names.
const STATUS_LINES = 20;

// The merged code a review reads: its diff text (a header saying the
// checkout is at the merge commit, the merge's commit messages and its
// first-parent patch), the range the bundle reads files from, the files the
// merge changed, and the merge commit's first parent and tree.
interface MergedCode {
  diff: string;
  range: { from: string; head: string };
  files: string[];
  parent: string;
  tree: string;
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

// Throws when the checkout `wt` holds uncommitted changes; nothing is
// stashed or discarded.
function assertNoCodeChanges(wt: string): void {
  const args = ["status", "--porcelain", "--ignore-submodules=all", "--", "."];
  const status = gitIn(wt, args).trim();
  if (status !== "") {
    throw new OpsError(
      `the checkout has uncommitted changes, so it can't be moved to the merged result; nothing was dropped:\n${tail(status, STATUS_LINES)}`,
    );
  }
}

// Detaches the checkout `wt` at the merge commit `sha` (already fetched by
// confirmMerged), and checks it ended at exactly `sha` and its tree. Safe to
// repeat.
function detachAt(wt: string, sha: string): void {
  if (head(wt) !== sha) {
    assertNoCodeChanges(wt);
    gitIn(wt, [
      "-c",
      "submodule.recurse=false",
      "checkout",
      "-q",
      "--detach",
      sha,
    ]);
  }
  const at = head(wt);
  const tree = gitIn(wt, ["rev-parse", "HEAD^{tree}"]).trim();
  const merged = gitIn(wt, ["rev-parse", `${sha}^{tree}`]).trim();
  if (at !== sha || tree !== merged) {
    throw new OpsError(
      `the checkout is at ${at} (tree ${tree}), not the merge commit ${sha} (tree ${merged})`,
    );
  }
}

// The merged code issue `n`'s review reads, once GitHub confirms PR
// `codeMerged.pr` merged as `codeMerged.sha` on the base; the issue's
// checkout is left detached at that commit.
function mergedCode(
  cfg: Config,
  n: number,
  codeMerged: CodeMerged,
): MergedCode {
  const wt = paths.worktree(cfg, n);
  const parent = confirmedMergedParent(cfg, n, wt, codeMerged);
  const { pr, sha } = codeMerged;
  const range = `${parent}..${sha}`;
  const files = nonEmptyLines(gitIn(wt, ["diff", "--name-only", range]));
  if (files.length === 0) {
    throw new OpsError(
      `merge commit ${sha} changes nothing against its first parent ${parent}, so there is no merged code to review`,
    );
  }
  detachAt(wt, sha);
  const patch = gitIn(wt, ["diff", "--stat", "--patch", range]);
  const header = `# Code\n\nPR #${pr} merged as ${sha}. The code checkout (repo/) is now at that merge commit, so its files are the merged result. Below is the merge commit's change against its first parent ${parent}, This is the complete net contribution relative to the integration-side parent, not a cumulative review of changes already in that parent.\n\n`;
  return {
    diff: `${header}${commitLog(wt, range)}${patch}`,
    range: { from: parent, head: sha },
    files,
    parent,
    tree: gitIn(wt, ["rev-parse", `${sha}^{tree}`]).trim(),
  };
}

export type { MergedCode };
export { assertNoCodeChanges, mergedCode };
