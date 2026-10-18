// What a repo's pipeline config file holds: its defaults, and the shape the
// ops modules check (src/config.ts loads it).

import { z } from "zod";

const DEFAULTS: Readonly<Record<string, unknown>> = {
  baseBranch: "main",
  // false: lanes finish issues already in progress (agent:working, answered
  // questions) but claim no new ones (Autumn, 2026-10-14).
  takeNewWork: true,
  // Issues with any of these labels are never pipeline work, such as deploy tickets.
  skipLabels: [],
  // The files that hold the project's coding practices, relative to the worktree
  // (wiki pages under the wiki's dir, such as "wiki/Decisions.md"). Writers and
  // reviewers read each in full (Axlog, 2026-10-15). Missing files are skipped.
  practices: ["AGENTS.md", "CONTRIBUTING.md"],
  leaseHours: 3,
  maxFixRounds: 2,
  maxCiFixes: 2,
  maxSyncs: 3,
  maxConflictFixes: 2,
  requireCi: true,
  ciWaitMinutes: 30,
  commandTimeoutMinutes: 20,
  lockfiles: [],
  migrations: null,
  // The orchestrator (#234): caps on live stage jobs, in all and per stage,
  // and its seconds between ticks.
  maxJobs: 4,
  stageCaps: { author: 2, review: 2 },
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
// What the ops modules read from a config. Every other key passes through as
// it is; config.ts warns about the keys the pipeline no longer reads.
// The model of each of the three model roles (`three-configurable-models`).
// config.ts fills each from the config's own models, through the documented
// mapping from the installed version's role names.
const MODELS = z.object({
  author: z.string().min(1),
  implementor: z.string().min(1),
  reviewer: z.string().min(1),
});

const CONFIG_SCHEMA = z.looseObject({
  account: z.string(),
  allowedUsers: z.array(z.string()),
  baseBranch: z.string(),
  cloneUrl: OPTIONAL_TEXT,
  commands: z.looseObject({ teardown: OPTIONAL_TEXT, test: z.string() }),
  gitEmail: OPTIONAL_TEXT,
  gitName: OPTIONAL_TEXT,
  // Deprecated (budgets-bound-context, Axlog, 2026-10-16): the per-issue token
  // budget that once stopped an issue. Accepted so older configs still load,
  // and unused.
  jobRoles: JOB_ROLES.nullish(),
  models: MODELS,
  leaseHours: z.number(),
  practices: z.array(z.string()),
  // Deprecated (budgets-bound-context, Axlog, 2026-10-16): the per-issue
  // rebase allowance (#201) that once stopped an issue. Accepted so older
  // configs still load, and unused.
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
      }),
    ])
    .nullish(),
});

type JobRolesConfig = z.infer<typeof JOB_ROLES>;

export type { JobRolesConfig };
export { CONFIG_SCHEMA, DEFAULTS };
