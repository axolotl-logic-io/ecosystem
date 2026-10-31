// Compatibility host for Gherkin's repository and credential-free model access.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type {
  GherkinCapabilities,
  GherkinSession,
  ReadOnlyRepository,
} from "@ecosystem/gherkin";
import { gherkinReply } from "@ecosystem/gherkin/reply";
import type { LaunchHooks } from "@ecosystem/task-runtime/job/launch";
import { pinPage } from "@ecosystem/task-runtime/job/prompts";
import {
  resultOf,
  SESSION_MINUTES,
} from "@ecosystem/task-runtime/job/session-result";
import { modelEnvironment } from "@ecosystem/task-runtime/model-environment";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { z } from "zod";
import type { Config } from "../config.ts";
import { openBaseCheckout } from "../job/checkout.ts";
import { runSession } from "../job/launch.ts";
import { JOB_REPO } from "../job/layout.ts";
import { promptsDir } from "../job/prompts.ts";
import { taskRunFile } from "./run-record.ts";
import type { TaskRun } from "./task-app.ts";

const MINUTE_MS = 60_000;

function hooksOf(cfg: Config, dir: string, repo: string): LaunchHooks {
  const env = modelEnvironment(process.env, []);
  const hooks: LaunchHooks = {
    sessionFile: (key: string): string =>
      path.join(dir, "sessions", `${key}.jsonl`),
    started: (): void => undefined,
    record: (): void => undefined,
    ended: (): void => undefined,
    sessionEnded: (): void => undefined,
    env: (): Readonly<Record<string, string>> => env,
    cwd: dir,
    repo,
  };
  if (cfg.runtime !== undefined) {
    hooks.runtime = cfg.runtime;
  }
  return hooks;
}

function gherkinSessionHost(
  run: TaskRun,
  cfg: Config,
): { capabilities: GherkinCapabilities; cleanup: () => Promise<void> } {
  const { repo: name, number } = run.issue;
  const dir = path.dirname(taskRunFile(name, number, run.run));
  const repo = path.join(dir, JOB_REPO);
  const issueFile = path.join(dir, "issue.md");
  return {
    capabilities: {
      openRepository: (): Promise<ReadOnlyRepository> => {
        run.checkStop();
        const revision = openBaseCheckout(cfg, repo);
        return Promise.resolve({ directory: repo, revision });
      },
      runModel: async (session: GherkinSession): Promise<unknown> => {
        run.checkStop();
        fs.writeFileSync(issueFile, session.inputs.issue.context);
        const prompt = pinPage(promptsDir(), "gherkin.md");
        const task = [
          `# Issue #${number} in ${name}: \`gherkin\``,
          "",
          "- Task: `gherkin`",
          `- Issue file: \`${issueFile}\``,
          `- Code checkout: \`${session.repository.directory}\`, detached at the head of \`${session.inputs.baseBranch}\` (${session.repository.revision})`,
          `- Target branch: \`${session.inputs.baseBranch}\``,
          "",
          ...session.facts,
        ].join("\n");
        const raw = await runSession(
          {
            key: "gherkin-1",
            profile: "gherkin",
            agent: "issue-pipeline-gherkin",
            model: session.inputs.model,
            task,
            outputSchema: z.toJSONSchema(gherkinReply),
            timeoutMs: SESSION_MINUTES.gherkin * MINUTE_MS,
            commits: false,
            phase: null,
            prompt,
          },
          hooksOf(cfg, dir, repo),
        );
        const result = resultOf(raw, gherkinReply);
        if (!result.ok) {
          throw new OpsError(`the gherkin session failed: ${result.error}`);
        }
        return result.reply;
      },
    },
    cleanup: (): Promise<void> => {
      fs.rmSync(repo, { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}

export { gherkinSessionHost };
