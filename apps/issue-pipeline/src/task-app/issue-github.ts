// Host-only credential transport for the shared issue adapter.

import type { RunResult } from "@ecosystem/task-runtime/command";
import type { IssueRef } from "@ecosystem/task-runtime/issue/issue-github";
import { IssueGitHub } from "@ecosystem/task-runtime/issue/issue-github";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import type { z } from "zod";
import { redactGhArgs } from "../github.ts";
import { credentialedRun } from "../github-auth.ts";
import { observeAll, unreadable } from "../github-observation.ts";
import { GH_TIMEOUT_MS, githubRead } from "../github-read.ts";
import { runFailure } from "../process.ts";

function issueGitHub(
  issue: IssueRef,
  actor: { account: string; env: ReadonlyMap<string, string> },
): IssueGitHub {
  function request(args: readonly string[], input?: string): RunResult {
    const options: Parameters<typeof credentialedRun>[2] = {
      env: actor.env,
      allowFail: true,
      timeoutMs: GH_TIMEOUT_MS,
    };
    if (input !== undefined) {
      options.input = input;
    }
    return credentialedRun("gh", args, options);
  }
  return new IssueGitHub(issue, {
    account: actor.account,
    transport: {
      request,
      read: (args: readonly string[]): RunResult =>
        githubRead(() => request(args)).result,
      list: <S extends z.ZodType>(path: string, row: S): z.output<S>[] => {
        const observation = observeAll(actor.env, path, row);
        if (observation.status !== "ok") {
          throw new OpsError(`cannot read ${path}: ${unreadable(observation)}`);
        }
        return observation.value;
      },
      redact: redactGhArgs,
      failure: (args: readonly string[], result: RunResult): OpsError =>
        new OpsError(
          runFailure("gh", redactGhArgs(args), result, {}).replaceAll(
            actor.env.get("GH_TOKEN") ?? "",
            "<token>",
          ),
        ),
    },
  });
}

export { issueGitHub };
