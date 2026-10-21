// What a repo's pipeline config file holds: its defaults, and the shape the
// ops modules check (src/config.ts loads it).

import { z } from "zod";
import { RUNTIME_SCHEMA } from "./job/runtime-policy.ts";
import { OpsError } from "./ops-error.ts";

const MIDDLE_CONFIRMATION_BACKOFF_SECONDS = 4;
const LATE_CONFIRMATION_BACKOFF_SECONDS = 8;
const FINAL_CONFIRMATION_BACKOFF_SECONDS = 10;
const MAX_CONFIRMATION_DEADLINE_SECONDS = 600;
const MAX_CONFIRMATION_BACKOFF_STEPS = 20;

const DEFAULTS: Readonly<Record<string, unknown>> = {
  baseBranch: "main",
  // false: lanes finish issues already in progress (agent:working, answered
  // questions) but claim no new ones (Autumn, 2026-10-14).
  takeNewWork: true,
  // Issues with any of these labels are never pipeline work, such as deploy tickets.
  skipLabels: [],
  // The files that hold the project's coding practices, relative to the worktree
  // (such as "docs/Decisions.md"). Writers and reviewers read each in full
  // (Axlog, 2026-10-15). Missing files are skipped.
  practices: ["AGENTS.md", "CONTRIBUTING.md"],
  leaseHours: 3,
  mergeConfirmation: {
    deadlineSeconds: 90,
    backoffSeconds: [
      1,
      2,
      MIDDLE_CONFIRMATION_BACKOFF_SECONDS,
      LATE_CONFIRMATION_BACKOFF_SECONDS,
      FINAL_CONFIRMATION_BACKOFF_SECONDS,
    ],
  },
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
  devAccount: z.string(),
  mergeAccount: z.string(),
  credentialsEnvFile: z.string(),
  legacyAccount: z.string().optional(),
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
  runtime: RUNTIME_SCHEMA,
  leaseHours: z.number(),
  // One read-only confirmation run, not renewed mutation authority. Bound both
  // knobs to avoid accidental busy loops or an effectively unbounded job.
  mergeConfirmation: z.object({
    deadlineSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_CONFIRMATION_DEADLINE_SECONDS),
    backoffSeconds: z
      .array(z.number().int().min(1).max(60))
      .min(1)
      .max(MAX_CONFIRMATION_BACKOFF_STEPS),
  }),
  practices: z.array(z.string()),
  // Deprecated (budgets-bound-context, Axlog, 2026-10-16): the per-issue
  // rebase allowance (#201) that once stopped an issue. Accepted so older
  // configs still load, and unused.
  repo: z.string(),
  usageFlags: z.object({
    firstContext: TOKENS,
    toolOutputShare: z.number().gt(0).max(1),
  }),
});

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/u;
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const PATH_SEPARATOR = /[\\/]/u;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/u;

function checkIdentities(
  configPath: string,
  raw: Readonly<Record<string, unknown>>,
): void {
  const {
    account,
    tokenFile,
    devAccount,
    mergeAccount,
    credentialsEnvFile,
    legacyAccount,
  } = raw;
  if (account !== undefined || tokenFile !== undefined) {
    throw new OpsError(
      "legacy account/tokenFile config is unsupported; migrate to distinct devAccount, mergeAccount and an absolute credentialsEnvFile",
    );
  }
  for (const [key, value] of Object.entries({ devAccount, mergeAccount })) {
    if (typeof value !== "string" || !GITHUB_USERNAME.test(value)) {
      throw new OpsError(
        `config ${configPath} must set ${key} to a GitHub username`,
      );
    }
  }
  if (
    typeof legacyAccount === "string" &&
    !GITHUB_USERNAME.test(legacyAccount)
  ) {
    throw new OpsError("legacyAccount must be a GitHub username");
  }
  if (String(devAccount).toLowerCase() === String(mergeAccount).toLowerCase()) {
    throw new OpsError("devAccount and mergeAccount must be distinct");
  }
  if (
    typeof credentialsEnvFile !== "string" ||
    !ABSOLUTE_PATH.test(credentialsEnvFile)
  ) {
    throw new OpsError("credentialsEnvFile must be an explicit absolute path");
  }
}

function checkUsers(configPath: string, users: unknown): void {
  if (!Array.isArray(users) || users.length === 0) {
    throw new OpsError(
      `config ${configPath} must set allowedUsers, a list of GitHub usernames whose issues and comments the pipeline reads`,
    );
  }
  for (const user of users) {
    if (typeof user !== "string" || !GITHUB_USERNAME.test(user)) {
      throw new OpsError(
        `bad GitHub username in allowedUsers: ${JSON.stringify(user)}`,
      );
    }
  }
}

function insideWorktree(entry: unknown): boolean {
  return (
    typeof entry === "string" &&
    entry !== "" &&
    !ABSOLUTE_PATH.test(entry) &&
    !entry.split(PATH_SEPARATOR).includes("..")
  );
}

function checkPractices(configPath: string, practices: unknown): void {
  if (!Array.isArray(practices)) {
    throw new OpsError(
      `config ${configPath}: practices must be a list of paths`,
    );
  }
  for (const entry of practices) {
    if (!insideWorktree(entry)) {
      throw new OpsError(
        `config ${configPath}: practices entry ${JSON.stringify(entry)} must be a path inside the worktree`,
      );
    }
  }
}

// The repo's docs are ordinary tracked Markdown under its own docs/, changed
// and reviewed with the code, so a config that still names a wiki was written
// for the wiki flow, which is gone: it fails rather than silently dropping it.
function checkNoWiki(
  configPath: string,
  raw: Readonly<Record<string, unknown>>,
): void {
  const { wiki } = raw;
  if (wiki !== undefined) {
    throw new OpsError(
      `config ${configPath} sets "wiki", which the pipeline no longer supports: docs are ordinary tracked Markdown in the repo's docs/, changed and reviewed with the code. Remove "wiki" from the config`,
    );
  }
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

const COMMANDS = z.looseObject({ test: z.unknown() });

// The checks whose messages tell an operator what to fix, in the order a
// config is usually written.
function checkRequired(
  configPath: string,
  raw: Readonly<Record<string, unknown>>,
): void {
  checkIdentities(configPath, raw);
  checkNoWiki(configPath, raw);
  const { allowedUsers, commands, practices, repo } = raw;
  if (!present(repo)) {
    throw new OpsError(`config ${configPath} is missing "repo"`);
  }
  const parsedCommands = COMMANDS.safeParse(commands);
  if (!(parsedCommands.success && present(parsedCommands.data.test))) {
    throw new OpsError(
      `config ${configPath} must set commands.test; the pipeline refuses repos without a test command`,
    );
  }
  if (typeof repo !== "string" || !REPO_NAME.test(repo)) {
    throw new OpsError(`bad repo "${String(repo)}"`);
  }
  checkUsers(configPath, allowedUsers);
  checkPractices(configPath, practices);
}

type JobRolesConfig = z.infer<typeof JOB_ROLES>;

export type { JobRolesConfig };
export { CONFIG_SCHEMA, checkRequired, DEFAULTS };
