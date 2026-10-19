// Records the Reviewer's approval on the exact checked code head, using the
// review/merge account rather than the PR's development account.
import { z } from "zod";
import type { Config } from "../config.ts";
import { ghJson } from "../github.ts";
import { OpsError } from "../ops-error.ts";

const APPROVAL = z.looseObject({
  state: z.literal("APPROVED"),
  commit: z.string(),
  login: z.string(),
});

function approvePr(cfg: Config, pr: number, head: string): void {
  const result = APPROVAL.parse(
    ghJson(cfg, "merge", [
      "api",
      `repos/${cfg.repo}/pulls/${pr}/reviews`,
      "--method",
      "POST",
      "-f",
      "event=APPROVE",
      "-f",
      `commit_id=${head}`,
      "--jq",
      "{state, commit: .commit_id, login: .user.login}",
    ]),
  );
  if (
    result.commit !== head ||
    result.login.toLowerCase() !== cfg.mergeAccount.toLowerCase()
  ) {
    throw new OpsError(
      "PR approval does not match the review account and head",
    );
  }
}

export { approvePr };
