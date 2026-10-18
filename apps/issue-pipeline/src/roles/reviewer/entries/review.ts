// The reviewer's `review` entry (the wiki's Pipeline-Roles-Reviewer, "Entry
// `review`"): prepare the head's review bundle, run the three lenses over it
// as one sessions effect, post their comments, and either save a clean
// review or merge the blocking findings with the aggregator and number them
// for the fixer.

import { launchBudget } from "../../../workflow/budget.ts";
import type { ReviewLens } from "../../../workflow/lenses.ts";
import { LENS_NAMES } from "../../../workflow/lenses.ts";
import { AGG_SCHEMA, REVIEW_SCHEMA } from "../../../workflow/review-schemas.ts";
import { lensTaskShared } from "../../../workflow/stages/review-prefix.ts";
import type { ReviewTaskItem } from "../../../workflow/stages/review-task-types.ts";
import { aggregateTask } from "../../../workflow/stages/review-text.ts";
import type { SessionEffect } from "../../machine.ts";
import type { SessionsEffect } from "../../sessions.ts";
import {
  aggregated,
  aggregateFailed,
  blocked,
  cleaned,
  failed,
  lensesReplied,
  prepared,
  stored,
} from "../edges.ts";
import type { ReviewerData } from "../locate.ts";
import { READER } from "../posting.ts";
import type { ReviewerSpec } from "../states.ts";
import { check } from "../states.ts";

// What the lenses read before prepare has run: no diff at all. Only a
// table check builds the lenses' effect from such data.
const NOTHING_PREPARED = { path: "(nothing prepared)", lines: "0" };

// What the tasks read of the issue.
function itemOf(data: ReviewerData): ReviewTaskItem {
  const { issue: n, context, spec } = data;
  return { n, paths: context.paths, st: spec };
}

function lensSession(data: ReviewerData, lens: ReviewLens): SessionEffect {
  const { cfg, budgets, models } = data.context;
  const review = data.review ?? NOTHING_PREPARED;
  return {
    kind: "session",
    name: `review-${lens}`,
    agent: READER,
    model: models[lens],
    schema: REVIEW_SCHEMA,
    task: lensTaskShared({ cfg }, itemOf(data), lens, review),
    ...launchBudget(budgets, "reviewer"),
    attempt: 1,
  };
}

// The three lenses, in LENS_NAMES order, run together in cache order.
function lenses(data: ReviewerData): SessionsEffect {
  return {
    kind: "sessions",
    sessions: LENS_NAMES.map((lens) => lensSession(data, lens)),
  };
}

function aggregate(data: ReviewerData): SessionEffect {
  const { cfg, budgets, models } = data.context;
  return {
    kind: "session",
    name: "aggregate",
    agent: READER,
    model: models.aggregator,
    schema: AGG_SCHEMA,
    task: aggregateTask({ cfg }, itemOf(data), data.raw),
    ...launchBudget(budgets, "aggregator"),
    attempt: 1,
  };
}

const REVIEW_STATES: Readonly<
  Record<
    "prepare" | "lenses" | "post-lenses" | "aggregate" | "store-findings",
    ReviewerSpec
  >
> = {
  prepare: check("prepare", () => ({}), {
    ok: { to: "lenses", apply: prepared },
    empty: { to: "nothing-to-review" },
    failed: { to: "prep-failed", apply: failed },
  }),
  lenses: {
    kind: "session",
    effect: lenses,
    on: { replied: { to: "post-lenses", apply: lensesReplied } },
  },
  "post-lenses": check(
    "post-lenses",
    (data: ReviewerData) => ({
      pr: data.pr,
      headSha: data.headSha ?? null,
      replies: data.lensReplies,
    }),
    {
      clean: { to: "clean", apply: cleaned },
      blocking: { to: "aggregate", apply: blocked },
      "lens-failed": { to: "lens-failed", apply: failed },
    },
  ),
  aggregate: {
    kind: "session",
    effect: aggregate,
    on: {
      replied: { to: "store-findings", apply: aggregated },
      failed: { to: "store-findings", apply: aggregateFailed },
    },
  },
  "store-findings": check(
    "store-findings",
    (data: ReviewerData) => ({
      pr: data.pr,
      nextFindingId: data.nextFindingId ?? 0,
      raw: data.raw,
      merged: data.merged,
    }),
    { ok: { to: "findings-stored", apply: stored } },
  ),
};

export { REVIEW_STATES };
