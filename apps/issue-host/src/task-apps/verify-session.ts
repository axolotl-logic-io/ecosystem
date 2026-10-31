// Verify's one read-only Reviewer session on the head under review: the
// installed `issue-pipeline-reviewer` agent, with the pinned `verify.md`
// prompt page, in the run's checkout of that head. Its task names the
// issue file, the checkout, the base and the diff of the PR's whole
// contribution. The session holds no token and no commit scope. Its reply
// is the review's summary and findings; it grants nothing. The session's
// JSONL goes in the task run's folder beside its run record.

import path from "node:path";
import process from "node:process";
import type { LaunchHooks } from "@ecosystem/task-runtime/job/launch";
import { pinPage } from "@ecosystem/task-runtime/job/prompts";
import {
  resultOf,
  SESSION_MINUTES,
} from "@ecosystem/task-runtime/job/session-result";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import type { VerifyReply } from "@ecosystem/verify/reply";
import { VERIFY_REPLY } from "@ecosystem/verify/reply";
import { taskText } from "@ecosystem/verify/session";
import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { writeIssueContext } from "../issue-context.ts";
import { agentEnvOf } from "../job/agent-env.ts";
import { runSession } from "../job/launch.ts";
import { promptsDir } from "../job/prompts.ts";
import type { HeadCheckout } from "./head-checkout.ts";

const AGENT = "issue-pipeline-reviewer";
const PAGE = "verify.md";
const PHASE = "security-review";
const MINUTE_MS = 60_000;

// What the session reviews: issue `issue` of `cfg.repo`, for task run
// `run`, at `checkout.head`, whose change starts at `base` on the base
// branch.
interface Review {
  cfg: Config;
  issue: number;
  run: string;
  checkout: HeadCheckout;
  base: string;
}

function hooksOf(review: Review): LaunchHooks {
  const { cfg, issue, run, checkout } = review;
  const env = agentEnvOf(cfg.jobRoles, process.env);
  const hooks: LaunchHooks = {
    sessionFile: (key: string): string =>
      path.join(
        paths.runDir(cfg, issue),
        "task-runs",
        run,
        "sessions",
        `${key}.jsonl`,
      ),
    started: (): void => undefined,
    record: (): void => undefined,
    ended: (): void => undefined,
    sessionEnded: (): void => undefined,
    env: (): Readonly<Record<string, string>> => env,
    cwd: checkout.root,
    repo: checkout.repo,
  };
  if (cfg.runtime !== undefined) {
    hooks.runtime = cfg.runtime;
  }
  return hooks;
}

// Runs the session and returns its reply; a session that ends without a
// valid reply throws.
async function reviewSession(review: Review): Promise<VerifyReply> {
  const { cfg, issue } = review;
  const { file } = writeIssueContext(cfg, issue);
  const raw = await runSession(
    {
      key: `reviewer-${PHASE}-1`,
      profile: "reviewer",
      agent: AGENT,
      model: cfg.models.reviewer,
      task: taskText(
        {
          repository: cfg.repo,
          baseBranch: cfg.baseBranch,
          testCommand: cfg.commands.test,
          issue,
          checkout: review.checkout,
          base: review.base,
        },
        file,
      ),
      outputSchema: z.toJSONSchema(VERIFY_REPLY),
      timeoutMs: SESSION_MINUTES.reviewer * MINUTE_MS,
      commits: false,
      phase: PHASE,
      prompt: pinPage(promptsDir(), PAGE),
    },
    hooksOf(review),
  );
  const result = resultOf(raw, VERIFY_REPLY);
  if (!result.ok) {
    throw new OpsError(`the review session judged nothing: ${result.error}`);
  }
  return VERIFY_REPLY.parse(result.reply);
}

export { reviewSession };
