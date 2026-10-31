// What a repo's pipeline config file holds: its defaults, and the shape the
// ops modules check (src/config.ts loads it).

import { RUNTIME_SCHEMA } from "@ecosystem/task-runtime/job/runtime-policy";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { PROJECT_POLICY_SOURCE } from "@ecosystem/task-runtime/project-policy-schema";
import { z } from "zod";

const DEFAULTS: Readonly<Record<string, unknown>> = {
  baseBranch: "main",
  // The files that hold the project's coding practices, relative to the worktree
  // (such as "docs/Decisions.md"). Writers and reviewers read each in full
  // (Axlog, 2026-10-15). Missing files are skipped.
  practices: ["AGENTS.md", "CONTRIBUTING.md"],
  requireCi: true,
  ciWaitMinutes: 30,
  commandTimeoutMinutes: 20,
  lockfiles: [],
  migrations: null,
};

const OPTIONAL_TEXT = z.string().nullish();
// The model a session gets when the config names none for it.
const DEFAULT_MODEL = "openai/gpt-6.1-sol";
const MODEL = z.string().min(1).default(DEFAULT_MODEL);
// Session model selectors; developer and reviewer are installed interface names.
const MODELS = z
  .object({ gherkin: MODEL, developer: MODEL, reviewer: MODEL })
  .default({
    gherkin: DEFAULT_MODEL,
    developer: DEFAULT_MODEL,
    reviewer: DEFAULT_MODEL,
  });

type SessionProfile = keyof z.infer<typeof MODELS>;

// What the ops modules read from a config. Every other key passes through as
// it is.
const CONFIG_SCHEMA = z.looseObject({
  projectPolicy: PROJECT_POLICY_SOURCE,
  devAccount: z.string(),
  landingAccount: z.string(),
  verifyAccount: z.string().min(1).optional(),
  credentialsEnvFile: z.string(),
  allowedUsers: z.array(z.string()),
  baseBranch: z.string(),
  requireCi: z.boolean(),
  cloneUrl: OPTIONAL_TEXT,
  commands: z.looseObject({
    teardown: OPTIONAL_TEXT,
    prune: OPTIONAL_TEXT,
    test: z.string(),
  }),
  gitEmail: OPTIONAL_TEXT,
  gitName: OPTIONAL_TEXT,
  models: MODELS,
  runtime: RUNTIME_SCHEMA,
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

export type { SessionProfile };
export { CONFIG_SCHEMA, checkRequired, DEFAULTS };
