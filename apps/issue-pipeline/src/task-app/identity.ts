// Who a task app acts as: the GitHub account a buddy file names, with its
// token from the operator's private credential file, checked against
// GitHub before any other call. The buddy file and the repository config
// it names for the issue's repository must be the operator's own. Until
// each buddy file names its credential itself (#248), the token is the one
// the repository config's credential file holds for that account, as its
// `devAccount` or `landingAccount`.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CREDENTIAL_VARIABLES, readCredential } from "../config.ts";
import { credentialedRun } from "../github-auth.ts";
import { GH_TIMEOUT_MS, githubRead } from "../github-read.ts";
import { OpsError } from "../ops-error.ts";
import { untrustedFile } from "../trusted-file.ts";

const MAX_CLAIM_WAIT_MS = 60_000;
const MAX_CLAIM_WAITS = 10;
const FIRST_CLAIM_WAIT_MS = 500;
const CLAIM_WAITS = 4;
// The default pauses double from the first.
const DEFAULT_CLAIM_WAITS_MS: readonly number[] = Array.from(
  { length: CLAIM_WAITS },
  (_unused, at) => FIRST_CLAIM_WAIT_MS * 2 ** at,
);

const BUDDY_FILE = z.looseObject({
  scope: z.looseObject({ repositories: z.array(z.string()).min(1) }),
  identity: z.looseObject({
    account: z.looseObject({ login: z.string().min(1) }),
  }),
  // Pauses, in milliseconds, between rereads of the timeline while it
  // doesn't yet show this buddy's removal of a start label.
  claimWaitsMs: z
    .array(z.int().min(0).max(MAX_CLAIM_WAIT_MS))
    .max(MAX_CLAIM_WAITS)
    .optional(),
});
const REPOSITORY_CONFIG = z.looseObject({
  repo: z.string(),
  baseBranch: z.string().default("main"),
  devAccount: z.string(),
  landingAccount: z.string(),
  credentialsEnvFile: z.string(),
});

interface Identity {
  account: string;
  env: ReadonlyMap<string, string>;
  // The repository's base branch, which an issue's branch is compared with.
  base: string;
  claimWaitsMs: readonly number[];
}

function trustedJson(file: string, what: string): unknown {
  const problem = untrustedFile(file);
  if (problem === "unreadable") {
    throw new OpsError(`${what} ${file} is unreadable`);
  }
  if (problem === "shared") {
    throw new OpsError(
      `${what} ${file} must be a regular file owned by this user and writable by no one else`,
    );
  }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return value;
  } catch (error) {
    throw new OpsError(`${what} ${file} is not JSON`, { cause: error });
  }
}

function parsed<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new OpsError(`${what}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// Refuses unless GitHub says `env`'s token is `account`'s.
function verify(account: string, env: ReadonlyMap<string, string>): void {
  const { result } = githubRead(() =>
    credentialedRun("gh", ["api", "user", "--jq", ".login"], {
      env,
      allowFail: true,
      timeoutMs: GH_TIMEOUT_MS,
    }),
  );
  const login = result.stdout.trim();
  if (result.code !== 0 || !same(login, account)) {
    throw new OpsError(
      `cannot verify the credential of @${account}: gh exit ${result.code}, observed ${JSON.stringify(login)}`,
    );
  }
}

// The identity `buddyFile` gives for work in repository `repo`.
function loadIdentity(buddyFile: string, repo: string): Identity {
  if (!path.isAbsolute(buddyFile)) {
    throw new OpsError("--config must be an absolute path");
  }
  const buddy = parsed(
    BUDDY_FILE,
    trustedJson(buddyFile, "buddy config"),
    `buddy config ${buddyFile}`,
  );
  const account = buddy.identity.account.login;
  const config = buddy.scope.repositories
    .filter((file) => path.isAbsolute(file))
    .map((file) =>
      parsed(
        REPOSITORY_CONFIG,
        trustedJson(file, "repository config"),
        `repository config ${file}`,
      ),
    )
    .find((candidate) => same(candidate.repo, repo));
  if (config === undefined) {
    throw new OpsError(`${repo} is not in the buddy's scope`);
  }
  let variable: string;
  if (same(account, config.devAccount)) {
    variable = CREDENTIAL_VARIABLES.dev;
  } else if (same(account, config.landingAccount)) {
    variable = CREDENTIAL_VARIABLES.landing;
  } else {
    throw new OpsError(`@${account} is not an account of ${repo}'s config`);
  }
  if (!path.isAbsolute(config.credentialsEnvFile)) {
    throw new OpsError("credentialsEnvFile must be an absolute path");
  }
  const token = readCredential(config.credentialsEnvFile, variable, account);
  const env = new Map([
    ["GH_PROMPT_DISABLED", "1"],
    ["GH_HOST", "github.com"],
    ["GH_TOKEN", token],
  ]);
  verify(account, env);
  return {
    account,
    env,
    base: config.baseBranch,
    claimWaitsMs: buddy.claimWaitsMs ?? DEFAULT_CLAIM_WAITS_MS,
  };
}

export type { Identity };
export { loadIdentity };
