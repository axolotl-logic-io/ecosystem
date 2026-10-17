// @ts-check
// What a role's locate reads besides the saved state (RoleContext), for issue
// #7: a repo config with the sweep's settings, its budgets and models as a
// job reads them, the claim's paths, and a fixed clock; and the job's config.
import { sweepSettings } from "../src/workflow/sweep-config.ts";

/** @import { Config } from "../src/config.ts" */
/** @import { RoleContext } from "../src/roles/walk.ts" */
/** @import { SweepConfig } from "../src/workflow/stages/types.ts" */

const ROLE_CLOCK = new Date("2026-10-16T12:00:00Z");
// The job's id, which signs the role's comments.
const JOB_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

/** @type {SweepConfig} */
const SWEEP_CONFIG = {
  repo: "o/r",
  baseBranch: "integration",
  maxTriages: 4,
  maxFixRounds: 2,
  maxSyncs: 3,
  maxCiFixes: 1,
  ciWaitMinutes: 30,
  maxContinuations: 1,
  commands: {},
  sessionTokenCap: 150_000,
  contextLimits: { soft: 150_000, hard: 175_000 },
};

/**
 * Issue #7's context, with `fields` replacing the config's.
 * @param {Partial<SweepConfig>} [fields]
 * @returns {RoleContext}
 */
function roleContext(fields = {}) {
  const cfg = { ...SWEEP_CONFIG, ...fields };
  const { budgets, models } = sweepSettings(cfg);
  return {
    issue: 7,
    jobId: JOB_ID,
    cfg,
    budgets,
    models,
    paths: {
      worktree: "/jobs/issue-7-triage",
      issueFile: "/runs/issue-7/issue.md",
      wiki: null,
      handoffFile: "/runs/issue-7/handoff.md",
    },
    now: ROLE_CLOCK,
  };
}

// The job's config a role's run reads, for a role whose checks read none.
/** @type {Config} */
const JOB_CONFIG = {
  account: "bot",
  allowedUsers: ["alice"],
  baseBranch: "integration",
  claimWaitSeconds: [0, 0],
  commands: { test: "true" },
  contextLimits: { soft: 150_000, hard: 175_000 },
  leaseHours: 3,
  maxContinuations: 1,
  issueTokenBudget: 1_000_000,
  usageFlags: { firstContext: 40_000, toolOutputShare: 0.25 },
  practices: [],
  repo: "o/r",
  slug: "o__r",
};

export { JOB_CONFIG, JOB_ID, ROLE_CLOCK, roleContext };
