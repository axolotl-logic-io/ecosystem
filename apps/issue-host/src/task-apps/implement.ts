// Installed compatibility bootstrap. Task decisions live in tasks/implement.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  type ImplementCapabilities,
  type ImplementCheckout,
  type ImplementSessions,
  implement,
} from "@ecosystem/implement";
import type { PullRequest } from "@ecosystem/task-runtime/issue/recovery";
import type { PushReply } from "@ecosystem/task-runtime/job/control-protocol";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { loadConfig } from "../config.ts";
import { run as runProcess } from "../process.ts";
import {
  type BranchCheckout,
  openBranchCheckout,
} from "../task-app/branch-checkout.ts";
import { issueBrief } from "../task-app/issue-brief.ts";
import { taskRunFile } from "../task-app/run-record.ts";
import { openSessions } from "../task-app/sessions.ts";
import { main, type TaskRun } from "../task-app/task-app.ts";
import { execute } from "./execute.ts";

const COMMIT_ENV: ReadonlyMap<string, string> = new Map([
  ["ISSUE_PIPELINE_COMMIT", "1"],
  ["GIT_EDITOR", "true"],
]);
async function work(run: TaskRun): Promise<void> {
  const cfg = loadConfig(run.config);
  const folder = path.dirname(
    taskRunFile(run.issue.repo, run.issue.number, run.run),
  );
  let checkout: BranchCheckout | null = null;
  const capabilities: ImplementCapabilities = {
    github: run.github,
    recovery: run.recovery,
    checkStop: run.checkStop,
    report: run.comment,
    openCheckout: (): ImplementCheckout => {
      const opened = openBranchCheckout(cfg, run.issue.number, run.run);
      checkout = opened;
      return {
        ...opened,
        start: (issue: number): void => {
          run.checkStop();
          runProcess(
            "git",
            [
              "-C",
              opened.dirs.repo,
              "commit",
              "--quiet",
              "--allow-empty",
              "-m",
              `Start work on #${issue}`,
            ],
            { env: COMMIT_ENV },
          );
        },
      };
    },
    writeBrief: (pull: PullRequest): string => {
      const brief = path.join(folder, "issue.md");
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(brief, issueBrief(run, cfg.baseBranch, pull));
      return brief;
    },
    openSessions: async (push: () => PushReply): Promise<ImplementSessions> => {
      if (checkout === null) {
        throw new OpsError("Implement has no checkout");
      }
      return await openSessions(cfg, {
        dir: folder,
        checkout: checkout.dirs,
        binding: {
          instance: run.run,
          lane: implement.id,
          issue: run.issue.number,
          branch: `agent/issue-${run.issue.number}`,
          repo: run.issue.repo,
          base: cfg.baseBranch,
        },
        push,
        env: checkout.env,
      });
    },
    retained: (error: unknown): void => {
      process.stderr.write(
        `task app implement: checkout kept: ${String(error)}\n`,
      );
    },
  };
  await execute(
    implement,
    {
      issue: run.issue,
      account: run.account,
      developmentAccount: cfg.devAccount,
      baseBranch: cfg.baseBranch,
      testCommand: cfg.commands.test,
      model: cfg.models.developer,
    },
    capabilities,
    run,
  );
}
await main({ id: implement.id, work });
