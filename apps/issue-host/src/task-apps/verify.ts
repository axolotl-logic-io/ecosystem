// The installed `verify.mjs`: provisions Verify's checks, session and review
// submission. Verify owns review and retry decisions.

import { reviewArtifact } from "@ecosystem/task-runtime/issue/review-artifact";
import {
  type HeadCheckout,
  type VerifyCapabilities,
  verify,
} from "@ecosystem/verify";
import type { PlannedReview } from "@ecosystem/verify/review";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import { redactLocalPaths } from "../host-paths.ts";
import { changedFiles, runChecks } from "../ops/checks.ts";
import { commentable } from "../ops/verify-review.ts";
import { redactAddresses } from "../redact-addresses.ts";
import { main, type TaskRun } from "../task-app/task-app.ts";
import { changeBase } from "./change-base.ts";
import { execute } from "./execute.ts";
import {
  checkoutState,
  commitOf,
  openHeadCheckout,
  removeHeadCheckout,
  trackedChanges,
} from "./head-checkout.ts";
import type { Submitted } from "./submit-review.ts";
import { submitReview } from "./submit-review.ts";
import { reviewSession } from "./verify-session.ts";

const CI_SETTINGS = z.looseObject({ ciWaitMinutes: z.number().positive() });
async function work(run: TaskRun): Promise<void> {
  const cfg = loadConfig(run.config);
  const capabilities: VerifyCapabilities = {
    readPull: run.recovery.pullRequest,
    checkStop: run.checkStop,
    report: run.comment,
    openCheckout: (head: string): HeadCheckout =>
      openHeadCheckout(cfg, run.issue.number, {
        task: verify.id,
        run: run.run,
        head,
      }),
    removeCheckout: removeHeadCheckout,
    checkoutState,
    baseCommit: (checkout: HeadCheckout): string =>
      commitOf(checkout, `origin/${cfg.baseBranch}`),
    fullChecks: (checkout: HeadCheckout, base: string): string[] => {
      const checked = runChecks(cfg, run.issue.number, {
        dir: checkout.repo,
        sha: checkout.head,
        changed: changedFiles(
          checkout.repo,
          changeBase(checkout.repo, base, checkout.head),
          checkout.head,
        ),
        keepTracked: true,
      });
      if (checked.checks.some((check) => check.id === "setup" && !check.pass)) {
        throw new Error(`the configured setup failed on ${checkout.head}`);
      }
      const tracked = trackedChanges(checkout);
      if (tracked !== "") {
        throw new Error(
          `the checks changed tracked files on ${checkout.head}: ${tracked.split("\n").join("; ")}`,
        );
      }
      return checked.checks
        .filter((check) => !check.pass)
        .map((check) => check.id);
    },
    reviewSession: (checkout: HeadCheckout, base: string): Promise<unknown> =>
      reviewSession({
        cfg,
        issue: run.issue.number,
        run: run.run,
        checkout,
        base,
      }),
    commentable: (
      checkout: HeadCheckout,
      base: string,
    ): Map<string, [number, number][]> =>
      commentable(
        checkout.repo,
        changeBase(checkout.repo, base, checkout.head),
        checkout.head,
      ),
    publishable: (text: string): string =>
      redactAddresses(redactLocalPaths(text)),
    submitReview: (
      pull: number,
      head: string,
      planned: PlannedReview,
    ): Submitted =>
      submitReview(run.github, {
        repo: run.issue.repo,
        pull,
        head,
        planned: {
          ...planned,
          body: reviewArtifact(run.run, planned.body, planned.counts),
        },
      }),
    sleep: (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
  await execute(
    verify,
    {
      issue: run.issue,
      account: run.account,
      baseBranch: cfg.baseBranch,
      testCommand: cfg.commands.test,
      model: cfg.models.reviewer,
      requireCi: cfg.requireCi,
      ciWaitMinutes: CI_SETTINGS.parse(cfg).ciWaitMinutes,
    },
    capabilities,
    run,
  );
}
await main({ id: verify.id, work });
