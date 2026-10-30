// Who a buddy acts as: the single GitHub account its buddy file
// (buddy-file.ts) names, with the token the file's credential entry
// selects from the operator's private credential file, checked against
// GitHub before any other call. Every write a buddy or its task apps make
// goes through this account.
import { hideCredentialVariable } from "../child-env.ts";
import { readCredential } from "../config.ts";
import { credentialedRun } from "../github-auth.ts";
import { GH_TIMEOUT_MS, githubRead } from "../github-read.ts";
import { OpsError } from "../ops-error.ts";
import { type BuddyFile, readBuddyFile } from "./buddy-file.ts";

interface Account {
  account: string;
  // The verified `gh` environment of `account`.
  env: ReadonlyMap<string, string>;
}
interface Identity extends Account {
  // The trusted repository settings file selected from this buddy's scope.
  config: string;
  // The repository's base branch, which an issue's branch is compared with.
  base: string;
  claimWaitsMs: readonly number[];
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

// The account `buddy` acts as, verified with GitHub.
function accountOf(buddy: BuddyFile): Account {
  const { account, credentials } = buddy;
  hideCredentialVariable(credentials.variable);
  const token = readCredential(credentials.file, credentials.variable, account);
  const env = new Map([
    ["GH_PROMPT_DISABLED", "1"],
    ["GH_HOST", "github.com"],
    ["GH_TOKEN", token],
  ]);
  verify(account, env);
  return { account, env };
}

// The identity `buddyFile` gives for work in repository `repo`.
function loadIdentity(buddyFile: string, repo: string, task: string): Identity {
  const buddy = readBuddyFile(buddyFile);
  if (!buddy.tasks.some((responsibility) => responsibility === task)) {
    throw new OpsError(`task ${task} is not in the buddy's tasks`);
  }
  const repository = buddy.repositories.find((item) => same(item.repo, repo));
  if (repository === undefined) {
    throw new OpsError(`${repo} is not in the buddy's scope`);
  }
  return {
    ...accountOf(buddy),
    config: repository.config,
    base: repository.base,
    claimWaitsMs: buddy.claimWaitsMs,
  };
}

export type { Account, Identity };
export { accountOf, loadIdentity };
