// The first reviewers' tasks over a review bundle (#415): every lens's task
// starts with the same prefix (the reviewer rules, the issue, the spec, the
// practices note and the bundle prepare-review wrote), so the lenses can share
// one read of the diff and the changed files. The lens's own part comes after
// it. A review with no bundle gets the diff-path task of review-text.ts.

import type { ReviewLens } from "../lenses.ts";
import { LENSES } from "../lenses.ts";
import { practicesNote } from "../practices.ts";
import { preamble } from "../prompts.ts";
import type { ReviewTaskContext, ReviewTaskItem } from "./review-task-types.ts";
import type { ReviewDiff } from "./review-text.ts";
import {
  LENS_OUTPUT_RULES,
  lensTask,
  SPEC_RULE_REVIEW,
  specSection,
} from "./review-text.ts";

// The review bundle's size bound, in characters (#415): changed files' head
// texts go into the bundle, in path order, while it stays within this; the
// first file that would pass it, and every file after it, is listed by path
// only. About 57k tokens at 3.5 characters a token, so a lens that starts
// with the bundle keeps most of its context for the review.
const REVIEW_BUNDLE_MAX_CHARS = 200_000;

// The review bundle prepare-review wrote beside the diff: its path and length
// in lines, as the op replied them, and its text.
interface ReviewBundle {
  bundlePath: string;
  bundleLines: number;
  bundleText: string;
}

// The lines every lens's task over `bundle` starts with. Nothing in them
// names a lens: the preamble's role is the plain "reviewer".
function sharedPrefix(
  ctx: ReviewTaskContext,
  state: ReviewTaskItem,
  bundle: ReviewBundle,
): string[] {
  const { cfg } = ctx;
  return preamble(cfg, state, "reviewer").concat([
    practicesNote(cfg, state, "reviewer"),
    ...specSection(state, SPEC_RULE_REVIEW),
    `The review bundle is at ${bundle.bundlePath} (${bundle.bundleLines} lines), and its text follows. It already holds the reviewed commits, the diff against ${cfg.baseBranch} and the changed files' text at the head, so open other files only for context the bundle lacks. Cite files by their paths in the repo.`,
    bundle.bundleText,
  ]);
}

// The first reviewer's task for `lens`: the shared prefix, then the lens's
// part, when `review` is a bundle; today's diff-path task when it is a diff.
function lensTaskShared(
  ctx: ReviewTaskContext,
  state: ReviewTaskItem,
  lens: ReviewLens,
  review: ReviewDiff | ReviewBundle,
): string {
  if (!("bundlePath" in review)) {
    return lensTask(ctx, state, lens, review);
  }
  return sharedPrefix(ctx, state, review)
    .concat([
      // The lens's name comes before its role and concern, so the text the
      // tasks share ends before either.
      `Your lens is ${lens}: your role is reviewer (${lens}), and you review only this concern: ${LENSES[lens]}`,
      ...LENS_OUTPUT_RULES,
    ])
    .join("\n");
}

export type { ReviewBundle };
export { lensTaskShared, REVIEW_BUNDLE_MAX_CHARS };
