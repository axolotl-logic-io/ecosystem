// A launcher buddy's trusted configuration: one strict JSON file, version 2,
// that names the buddy's scope (the repository configs it covers), the
// tasks whose start labels it launches, its single GitHub account and the
// entry of the operator's private credential file that holds that
// account's token. The buddy file and every repository config it names
// must be the operator's own and writable by no one else. A repository
// config is read only for its `repo` and `baseBranch`; the buddy's own
// account makes every write, so the repository's account pairing plays no
// part.
//
// Files of any other version are refused.
import fs from "node:fs";
import path from "node:path";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { z } from "zod";
import { untrustedFile } from "../trusted-file.ts";

const VERSION = 2;
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const BUDDY_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const JSON_FILE = /\.json$/u;
const MIN_POLL_SECONDS = 1;
const MAX_POLL_SECONDS = 3600;
const DEFAULT_POLL_SECONDS = 60;
const MAX_CLAIM_WAIT_MS = 60_000;
const MAX_CLAIM_WAITS = 10;
const FIRST_CLAIM_WAIT_MS = 500;
const CLAIM_WAITS = 4;
// The default pauses double from the first.
const DEFAULT_CLAIM_WAITS_MS: readonly number[] = Array.from(
  { length: CLAIM_WAITS },
  (_unused, at) => FIRST_CLAIM_WAIT_MS * 2 ** at,
);
// The tasks a start label starts, each one task app.
const LAUNCHED_TASKS = [
  "gherkin",
  "implement",
  "verify",
  "fix",
  "land",
] as const;

const ABSOLUTE_PATH = z
  .string()
  .refine((file) => path.isAbsolute(file), "must be an absolute path")
  .transform((file) => path.resolve(file));
const TASK = z.enum(LAUNCHED_TASKS);
const BUDDY_FILE = z.strictObject({
  version: z.literal(VERSION),
  name: z.string().regex(BUDDY_NAME),
  scope: z.strictObject({ repositories: z.array(ABSOLUTE_PATH).min(1) }),
  tasks: z.array(TASK).min(1),
  account: z.strictObject({
    login: z.string().regex(GITHUB_NAME),
    credentials: z.strictObject({
      file: ABSOLUTE_PATH,
      variable: z.string().regex(VARIABLE),
    }),
  }),
  pollSeconds: z
    .int()
    .min(MIN_POLL_SECONDS)
    .max(MAX_POLL_SECONDS)
    .default(DEFAULT_POLL_SECONDS),
  // Pauses, in milliseconds, between rereads of the timeline while it
  // doesn't yet show this buddy's removal of a start label.
  claimWaitsMs: z
    .array(z.int().min(0).max(MAX_CLAIM_WAIT_MS))
    .max(MAX_CLAIM_WAITS)
    .default([...DEFAULT_CLAIM_WAITS_MS]),
});
const REPOSITORY_CONFIG = z.looseObject({
  repo: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
});
// The account any buddy file in a folder names: a launcher buddy's
// `account.login`, or an earlier buddy file's `identity.account.login`.
const ACCOUNT = z.looseObject({ login: z.string() });
const ANY_BUDDY = z.union([
  z.looseObject({ account: ACCOUNT }).transform(({ account }) => account),
  z
    .looseObject({ identity: z.looseObject({ account: ACCOUNT }) })
    .transform(({ identity }) => identity.account),
]);

type LaunchedTask = z.infer<typeof TASK>;
interface BuddyRepository {
  config: string;
  repo: string;
  base: string;
}
interface BuddyFile {
  file: string;
  name: string;
  tasks: readonly LaunchedTask[];
  account: string;
  credentials: { file: string; variable: string };
  repositories: readonly BuddyRepository[];
  pollSeconds: number;
  claimWaitsMs: readonly number[];
}

function refuse(file: string, reason: string): never {
  throw new OpsError(`buddy config ${file}: ${reason}`);
}

function trustedJson(file: string, what: string, owner: string): unknown {
  const problem = untrustedFile(file);
  if (problem === "unreadable") {
    refuse(owner, `${what} ${file} is unreadable`);
  }
  if (problem === "shared") {
    refuse(
      owner,
      `${what} ${file} must be a regular file owned by this user and writable by no one else`,
    );
  }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return value;
  } catch (error) {
    return refuse(owner, `${what} ${file} is not JSON: ${String(error)}`);
  }
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function repeatedIn(items: readonly string[]): string | null {
  return (
    items.find(
      (item, at) => items.findIndex((other) => same(other, item)) !== at,
    ) ?? null
  );
}

function repositoryOf(owner: string, config: string): BuddyRepository {
  const parsed = REPOSITORY_CONFIG.safeParse(
    trustedJson(config, "repository config", owner),
  );
  if (!parsed.success) {
    return refuse(
      owner,
      `repository config ${config}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return { config, repo: parsed.data.repo, base: parsed.data.baseBranch };
}

// The launcher buddy file at `file`, validated, with each repository in its
// scope read. Throws, before any effect, on anything it doesn't settle.
function readBuddyFile(file: string): BuddyFile {
  if (!path.isAbsolute(file)) {
    throw new OpsError("--config must be an absolute path");
  }
  const resolved = path.resolve(file);
  const parsed = BUDDY_FILE.safeParse(
    trustedJson(resolved, "the buddy config", resolved),
  );
  if (!parsed.success) {
    return refuse(resolved, z.prettifyError(parsed.error));
  }
  const buddy = parsed.data;
  const task = repeatedIn(buddy.tasks);
  if (task !== null) {
    refuse(resolved, `task ${task} is listed twice`);
  }
  if (repeatedIn(buddy.scope.repositories) !== null) {
    refuse(resolved, "a repository config is listed twice");
  }
  const repositories = buddy.scope.repositories.map((config) =>
    repositoryOf(resolved, config),
  );
  const repo = repeatedIn(repositories.map((item) => item.repo));
  if (repo !== null) {
    refuse(resolved, `two repository configs name ${repo}`);
  }
  return {
    file: resolved,
    name: buddy.name,
    tasks: buddy.tasks,
    account: buddy.account.login,
    credentials: buddy.account.credentials,
    repositories,
    pollSeconds: buddy.pollSeconds,
    claimWaitsMs: buddy.claimWaitsMs,
  };
}

function accountIn(file: string): string | null {
  try {
    const parsed = ANY_BUDDY.safeParse(
      JSON.parse(fs.readFileSync(file, "utf8")),
    );
    if (!parsed.success) {
      return null;
    }
    return parsed.data.login;
  } catch {
    return null;
  }
}

// Another buddy file in `buddy`'s folder that names the same GitHub
// account, or null. The operator keeps a machine's buddy files in one
// folder; buddies on other machines are out of its sight.
function sharingAccount(buddy: BuddyFile): string | null {
  const folder = path.dirname(buddy.file);
  const others = fs
    .readdirSync(folder)
    .filter((name) => JSON_FILE.test(name))
    .map((name) => path.join(folder, name))
    .filter((file) => file !== buddy.file);
  return (
    others.find((file) => {
      const account = accountIn(file);
      return account !== null && same(account, buddy.account);
    }) ?? null
  );
}

export type { BuddyFile, BuddyRepository, LaunchedTask };
export { readBuddyFile, sharingAccount };
