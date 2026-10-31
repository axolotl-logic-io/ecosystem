// Who a buddy acts as: the single GitHub account its buddy file
// (buddy-file.ts) names, with the token the file's credential entry
// selects from the operator's private credential file, checked against
// GitHub before any other call. Every write a buddy or its task apps make
// goes through this account.
import { hideCredentialVariable } from "@ecosystem/task-runtime/child-env";
import { readCredential } from "@ecosystem/task-runtime/credentials";
import {
  GH_TIMEOUT_MS,
  githubRead,
} from "@ecosystem/task-runtime/issue/github-read";
import { credentialedRun } from "@ecosystem/task-runtime/issue/transport";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import type { BuddyFile } from "./buddy-file.ts";

interface Account {
  account: string;
  // The verified `gh` environment of `account`.
  env: ReadonlyMap<string, string>;
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

export type { Account };
export { accountOf };
