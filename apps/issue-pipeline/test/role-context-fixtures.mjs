// @ts-check
// What a role's locate reads besides the saved state (RoleContext), for issue
// #7: a repo config with the sweep's settings, its budgets and models as a
// job reads them, the claim's paths, and a fixed clock.
import { sweepSettings } from "../src/workflow/sweep-config.ts";

/** @import { RoleContext } from "../src/roles/walk.ts" */
/** @import { SweepConfig } from "../src/workflow/stages/types.ts" */

const ROLE_CLOCK = new Date("2026-10-16T12:00:00Z");

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

export { ROLE_CLOCK, roleContext };
