// What a repo's pipeline config file holds: its defaults, and the shape the
// ops modules check (src/config.ts loads it).

import { z } from "zod";
import { RUNTIME_SCHEMA } from "./job/runtime-policy.ts";
import { OpsError } from "./ops-error.ts";
import { PROJECT_POLICY_SOURCE } from "./project-policy-schema.ts";

const MIDDLE_CONFIRMATION_BACKOFF_SECONDS = 4;
const LATE_CONFIRMATION_BACKOFF_SECONDS = 8;
const FINAL_CONFIRMATION_BACKOFF_SECONDS = 10;
const MAX_CONFIRMATION_DEADLINE_SECONDS = 600;
const MAX_CONFIRMATION_BACKOFF_STEPS = 20;
const MAX_LANE_SLOTS = 399;

const DEFAULTS: Readonly<Record<string, unknown>> = {
  baseBranch: "main",
  // The files that hold the project's coding practices, relative to the worktree
  // (such as "docs/Decisions.md"). Writers and reviewers read each in full
  // (Axlog, 2026-10-15). Missing files are skipped.
  practices: ["AGENTS.md", "CONTRIBUTING.md"],
  leaseHours: 3,
  landingConfirmation: {
    deadlineSeconds: 90,
    backoffSeconds: [
      1,
      2,
      MIDDLE_CONFIRMATION_BACKOFF_SECONDS,
      LATE_CONFIRMATION_BACKOFF_SECONDS,
      FINAL_CONFIRMATION_BACKOFF_SECONDS,
    ],
  },
  requireCi: true,
  ciWaitMinutes: 30,
  commandTimeoutMinutes: 20,
  lockfiles: [],
  migrations: null,
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DATABASE_FILE = /^(?:\/|[A-Za-z]:[\\/])/u;
const COORDINATION_STORE = z
  .discriminatedUnion("backend", [
    z.strictObject({ backend: z.literal("github") }),
    z.strictObject({
      backend: z.literal("postgres"),
      credentialsEnvFile: z
        .string()
        .regex(DATABASE_FILE, "must be an absolute path"),
    }),
  ])
  .default({ backend: "github" });

const OPTIONAL_TEXT = z.string().nullish();
// Access-profile metadata and credential-variable names to strip from model
// children (src/job/roles.ts). Declared hosts do not enforce a sandbox.
const JOB_ROLE = z
  .object({
    tokenEnv: z.string().regex(ENV_NAME, "must be an env var name").optional(),
    network: z.array(z.string().min(1)).optional(),
  })
  .optional();
const JOB_ROLES = z.object({
  reader: JOB_ROLE,
  writer: JOB_ROLE,
  lander: JOB_ROLE,
});
// The model a role gets when the config names none for it.
const DEFAULT_MODEL = "openai/gpt-6.1-sol";
const MODEL = z.string().min(1).default(DEFAULT_MODEL);
// The model of each of the three model roles (`three-configurable-models`).
const MODELS = z
  .object({ author: MODEL, developer: MODEL, reviewer: MODEL })
  .default({
    author: DEFAULT_MODEL,
    developer: DEFAULT_MODEL,
    reviewer: DEFAULT_MODEL,
  });

type ModelRole = keyof z.infer<typeof MODELS>;

// What the ops modules read from a config. Every other key passes through as
// it is.
const CONFIG_SCHEMA = z.looseObject({
  projectPolicy: PROJECT_POLICY_SOURCE,
  devAccount: z.string(),
  landingAccount: z.string(),
  credentialsEnvFile: z.string(),
  coordination: COORDINATION_STORE,
  allowedUsers: z.array(z.string()),
  baseBranch: z.string(),
  requireCi: z.boolean(),
  cloneUrl: OPTIONAL_TEXT,
  commands: z.looseObject({
    teardown: OPTIONAL_TEXT,
    prune: OPTIONAL_TEXT,
    test: z.string(),
  }),
  // Project-buddy's lane app ports must stay below its proxy port range.
  laneSlots: z.number().int().min(1).max(MAX_LANE_SLOTS).optional(),
  // The repository's own Land permission. Land needs it and the Gatekeeper
  // buddy's `permissions.land` (src/runtime/buddy-config.ts); missing is
  // false.
  permissions: z.strictObject({ land: z.boolean() }).optional(),
  gitEmail: OPTIONAL_TEXT,
  gitName: OPTIONAL_TEXT,
  jobRoles: JOB_ROLES.nullish(),
  models: MODELS,
  runtime: RUNTIME_SCHEMA,
  leaseHours: z.number(),
  // One read-only confirmation run, not renewed mutation authority. Bound both
  // knobs to avoid accidental busy loops or an effectively unbounded job.
  landingConfirmation: z.object({
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
  repo: z.string(),
});

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/u;
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const PATH_SEPARATOR = /[\\/]/u;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/u;

function checkIdentities(
  configPath: string,
  raw: Readonly<Record<string, unknown>>,
): void {
  const { devAccount, landingAccount, credentialsEnvFile } = raw;
  for (const [key, value] of Object.entries({ devAccount, landingAccount })) {
    if (typeof value !== "string" || !GITHUB_USERNAME.test(value)) {
      throw new OpsError(
        `config ${configPath} must set ${key} to a GitHub username`,
      );
    }
  }
  if (
    String(devAccount).toLowerCase() === String(landingAccount).toLowerCase()
  ) {
    throw new OpsError("devAccount and landingAccount must be distinct");
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

export type { JobRolesConfig, ModelRole };
export { CONFIG_SCHEMA, checkRequired, DEFAULTS, MAX_LANE_SLOTS };
