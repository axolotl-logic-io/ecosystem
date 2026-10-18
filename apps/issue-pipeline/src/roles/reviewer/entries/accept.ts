// The reviewer's `accept` entry (#423; the wiki's Pipeline-Roles-Reviewer,
// "Entry `accept`"): prepare the final diff at the verified head, keep the
// verdict acceptance last passed when the changes' patch id is unchanged
// (review-keeps-on-clean-rebase), and otherwise run the acceptance verifier
// on today's `accept` stage's task, saving a pass at security and a fail at
// fix with an open acceptance finding.

import { launchBudget } from "../../../workflow/budget.ts";
import { ACCEPT_SCHEMA } from "../../../workflow/schemas.ts";
import { acceptTask } from "../../../workflow/stages/accept.ts";
import type { SessionEffect } from "../../machine.ts";
import {
  deferred,
  finalPrepared,
  keptVerdict,
  passed,
  rejected,
  verdictReplied,
} from "../accept-edges.ts";
import { failed } from "../edges.ts";
import type { ReviewerData } from "../locate.ts";
import { READER } from "../posting.ts";
import type { ReviewerSpec } from "../states.ts";
import { check } from "../states.ts";

// What the verifier reads before prepare-accept has run: no diff at all.
// Only a table check builds the verifier's effect from such data.
const NOTHING_PREPARED = "(nothing prepared)";

function verifierSession(data: ReviewerData): SessionEffect {
  const { cfg, budgets, models, paths } = data.context;
  const st = { ...data.spec, verifySummary: data.verifySummary };
  const item = { n: data.issue, paths, st };
  return {
    kind: "session",
    name: "accept",
    agent: READER,
    model: models.verifier,
    schema: ACCEPT_SCHEMA,
    task: acceptTask(cfg, item, data.diffPath ?? NOTHING_PREPARED),
    ...launchBudget(budgets, "verifier"),
    attempt: 1,
  };
}

const ACCEPT_STATES: Readonly<
  Record<
    "prepare-accept" | "accept-work?" | "verifier" | "post-verdict",
    ReviewerSpec
  >
> = {
  "prepare-accept": check(
    "prepare-accept",
    (data: ReviewerData) => ({ verifiedSha: data.verifiedSha }),
    {
      ok: { to: "accept-work?", apply: finalPrepared },
      moved: { to: "accept-moved" },
      deferred: { to: "accept-deferred", apply: deferred },
      failed: { to: "accept-prep-failed", apply: failed },
    },
  ),
  "accept-work?": check(
    "accept-work?",
    (data: ReviewerData) => ({
      pr: data.pr,
      patchId: data.patchId,
      acceptedPatchId: data.acceptedPatchId ?? null,
      acceptedSha: data.acceptedSha ?? null,
    }),
    {
      kept: { to: "accepted", apply: keptVerdict },
      run: { to: "verifier" },
    },
  ),
  verifier: {
    kind: "session",
    effect: verifierSession,
    // A transient provider error never reaches `failed`: the runner holds
    // the run on it (src/job/step-failure.ts).
    on: {
      replied: { to: "post-verdict", apply: verdictReplied },
      failed: { to: "verifier-failed", apply: failed },
    },
  },
  "post-verdict": check(
    "post-verdict",
    (data: ReviewerData) => ({ pr: data.pr, verdict: data.verdict }),
    {
      pass: { to: "accepted", apply: passed },
      fail: { to: "acceptance-failed", apply: rejected },
      unreadable: { to: "verifier-failed" },
    },
  ),
};

export { ACCEPT_STATES };
