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
  issueTokenBudget: 1_000_000,
  // The rebase pool per issue: conflict resolvers, and re-checks after a rebase
  // the merge stage asked for (#201). Reset at merge and restart.
  rebaseTokenBudget: 500_000,
  sessionTokenCap: 150_000,
  // No writer session may pass `hard` tokens of context; past it, it hands off,
  // up to maxContinuations times per stage per issue (#264).
  contextLimits: { soft: 150_000, hard: 175_000 },
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
  // stage, the tokens its jobs may spend an hour, and its seconds between ticks.
  maxJobs: 4,
  stageCaps: { triage: 2, spec: 2, review: 2, accept: 2, security: 2 },
  tokensPerHour: 2_000_000,
  orchestratorIntervalSeconds: 60,
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const OPTIONAL_TEXT = z.string().nullish();
const TOKENS = z.number().int().positive();
// What a stage job's role may hold (src/job/roles.ts): the job variable its
// GH_TOKEN comes from, and the hosts it may reach.
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
  jobRoles: JOB_ROLES.nullish(),
  leaseHours: z.number(),
  maxContinuations: z.number().int().nonnegative(),
  practices: z.array(z.string()),
  repo: z.string(),
  tokenFile: OPTIONAL_TEXT,
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
