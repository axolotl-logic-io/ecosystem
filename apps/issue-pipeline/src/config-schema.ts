// What a repo's pipeline config file holds: its defaults, and the shape the
// ops modules check (src/config.ts loads it).

import { z } from "zod";

// A lane waits a random time in this range, in seconds, after claiming an issue.
const SHORTEST_CLAIM_WAIT = 5;
const LONGEST_CLAIM_WAIT = 20;

const DEFAULTS: Readonly<Record<string, unknown>> = {
  baseBranch: "main",
  // false: lanes finish issues already in progress (agent:working, answered
  // questions) but claim no new ones (Autumn, 2026-10-14).
  takeNewWork: true,
  // Issues with any of these labels are never pipeline work, such as deploy tickets.
  skipLabels: [],
  // The files that hold the project's coding practices, relative to the worktree
  // (wiki pages under the wiki's dir, such as "wiki/Decisions.md"). The spec writer
  // reads each in full and specs to them (Autumn, 2026-10-15). Missing files are skipped.
  practices: ["AGENTS.md", "CONTRIBUTING.md"],
  leaseHours: 3,
  // Caps each session's context budget, the context the orchestrator's
  // watchdog stops a writer session past; roleBudgets sets each role's. Budgets bound context, not spend (budgets-bound-context,
  // Axlog, 2026-10-16). 300000 puts a writer's kill above contextLimits.hard
  // (wrap-up-at-175k, Axlog, 2026-10-17).
  sessionTokenCap: 300_000,
  // A writer session past `soft` tokens of context is told to wrap up and
  // write its handoff, and one past `hard` is stopped; it hands off, up to
  // maxContinuations times per stage per issue (#264). loadConfig refuses a
  // `hard` at or above a writer's context budget, so the job's stop comes
  // before the watchdog's kill (wrap-up-at-175k, Axlog, 2026-10-17).
  contextLimits: { soft: 175_000, hard: 225_000 },
  maxContinuations: 1,
  maxFixRounds: 2,
  maxCiFixes: 2,
  maxSyncs: 3,
  maxConflictFixes: 2,
  maxTriages: 3,
  claimWaitSeconds: [SHORTEST_CLAIM_WAIT, LONGEST_CLAIM_WAIT],
  claimCandidates: 5,
  requireNewTests: true,
  requireCi: true,
  ciWaitMinutes: 30,
  commandTimeoutMinutes: 20,
  testPathGlobs: [
    "test/**",
    "tests/**",
    "**/__tests__/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/test_*.py",
    "**/*_test.go",
  ],
  nonCodePathGlobs: ["**/*.md", "docs/**"],
  lockfiles: [],
  migrations: null,
  // The orchestrator (#234): caps on live stage jobs, in all and per reader
  // stage, an optional throttle on the tokens its jobs may use an hour (input,
  // output and cache writes, not cache reads; null or 0, the default, means no
  // limit, budgets-bound-context), and its seconds between ticks.
  maxJobs: 4,
  stageCaps: { triage: 2, spec: 2, review: 2, accept: 2, security: 2 },
  tokensPerHour: null,
  orchestratorIntervalSeconds: 60,
  // What the usage report (report.mjs usage) flags: a session whose first turn
  // passed `firstContext` tokens of context, or whose largest tool output
  // passed `toolOutputShare` of its peak context (#302).
  usageFlags: { firstContext: 40_000, toolOutputShare: 0.25 },
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const OPTIONAL_TEXT = z.string().nullish();
const TOKENS = z.number().int().positive();
// What a stage job's role may hold (src/job/roles.ts): a job variable that
// holds its token, which no session sees, and the hosts it may reach.
const JOB_ROLE = z
  .object({
    tokenEnv: z.string().regex(ENV_NAME, "must be an env var name").optional(),
    network: z.array(z.string().min(1)).optional(),
  })
  .optional();
const JOB_ROLES = z.object({
  reader: JOB_ROLE,
  writer: JOB_ROLE,
  merger: JOB_ROLE,
});
// What the ops modules read from a config. Every other key passes through to
// the workflow as it is.
const CONFIG_SCHEMA = z.looseObject({
  account: z.string(),
  allowedUsers: z.array(z.string()),
  baseBranch: z.string(),
  claimWaitSeconds: z.tuple([z.number(), z.number()]),
  cloneUrl: OPTIONAL_TEXT,
  commands: z.looseObject({ teardown: OPTIONAL_TEXT, test: z.string() }),
  contextLimits: z
    .object({ hard: TOKENS, soft: TOKENS })
    .refine(
      ({ hard, soft }) => soft < hard,
      "contextLimits.soft must be below contextLimits.hard",
    ),
  gitEmail: OPTIONAL_TEXT,
  gitName: OPTIONAL_TEXT,
  // Deprecated (budgets-bound-context, Axlog, 2026-10-16): the per-issue token
  // budget that once stopped an issue. Accepted so older configs still load,
  // and unused.
  issueTokenBudget: z.unknown().optional(),
  jobRoles: JOB_ROLES.nullish(),
  leaseHours: z.number(),
  maxContinuations: z.number().int().nonnegative(),
  practices: z.array(z.string()),
  // Deprecated (budgets-bound-context, Axlog, 2026-10-16): the per-issue
  // rebase allowance (#201) that once stopped an issue. Accepted so older
  // configs still load, and unused.
  rebaseTokenBudget: z.unknown().optional(),
  repo: z.string(),
  tokenFile: OPTIONAL_TEXT,
  usageFlags: z.object({
    firstContext: TOKENS,
    toolOutputShare: z.number().gt(0).max(1),
  }),
  wiki: z
    .union([
      z.boolean(),
      z.looseObject({
        branch: z.string().optional(),
        dir: z.string().optional(),
        url: z.string().optional(),
      }),
    ])
    .nullish(),
});

type JobRolesConfig = z.infer<typeof JOB_ROLES>;

export type { JobRolesConfig };
export { CONFIG_SCHEMA, DEFAULTS };
