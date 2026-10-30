// A task app's read-only model session: one fresh `pi` session, run as an
// installed agent on its pinned prompt page, that reads the issue file
// (issue-file.ts) and a detached checkout of the base branch, and returns
// one structured reply. It holds no GitHub token and can't commit or edit;
// the task posts what the reply says. Its files stay in the run's folder
// beside the run record, except the checkout, which holds nothing to save
// and is removed when the session ends.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { ModelRole } from "../config-schema.ts";
import { openBaseCheckout } from "../job/checkout.ts";
import { type LaunchHooks, runSession } from "../job/launch.ts";
import { JOB_REPO } from "../job/layout.ts";
import { PROMPTS_DIR, pinPage } from "../job/prompts.ts";
import { resultOf, SESSION_MINUTES } from "../job/role-session.ts";
import { agentEnvOf, rolesOf } from "../job/roles.ts";
import { OpsError } from "../ops-error.ts";
import { writeIssueFile } from "./issue-file.ts";
import { taskRunFile } from "./run-record.ts";
import type { TaskRun } from "./task-app.ts";

const MINUTE_MS = 60_000;

// One session: the installed agent it runs as, its prompt page, the model
// role whose configured model and timeout it gets, the task's own facts
// after the issue file and the checkout, and the reply's schema.
interface SessionSpec<S extends z.ZodType> {
  agent: string;
  page: string;
  role: ModelRole;
  facts: readonly string[];
  schema: S;
}

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function hooksOf(cfg: Config, dir: string, repo: string): LaunchHooks {
  const env = agentEnvOf(rolesOf(cfg.jobRoles), process.env);
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

// Runs the session `spec` describes for `run`, whose repository config is
// `cfg`, and returns its reply. Throws when the session fails or its reply
// doesn't match the schema.
async function readOnlySession<S extends z.ZodType>(
  run: TaskRun,
  cfg: Config,
  spec: SessionSpec<S>,
): Promise<z.output<S>> {
  const { repo: name, number } = run.issue;
  const dir = path.dirname(taskRunFile(name, number, run.run));
  const repo = path.join(dir, JOB_REPO);
  const issueFile = path.join(dir, "issue.md");
  writeIssueFile(
    run.github,
    {
      allowedUsers: cfg.allowedUsers,
      pipeline: [cfg.devAccount, cfg.landingAccount, run.account],
    },
    issueFile,
  );
  const prompt = pinPage(PROMPTS_DIR, spec.page);
  try {
    const commit = openBaseCheckout(cfg, repo);
    const task = [
      `# Issue #${number} in ${name}: \`${run.task}\``,
      "",
      ...bullets([
        `Task: \`${run.task}\``,
        `Issue file: \`${issueFile}\``,
        `Code checkout: \`${repo}\`, detached at the head of \`${cfg.baseBranch}\` (${commit})`,
        `Target branch: \`${cfg.baseBranch}\``,
      ]),
      "",
      ...spec.facts,
    ].join("\n");
    run.checkStop();
    const raw = await runSession(
      {
        key: `${spec.role}-1`,
        role: spec.role,
        agent: spec.agent,
        model: cfg.models[spec.role],
        task,
        outputSchema: z.toJSONSchema(spec.schema),
        timeoutMs: SESSION_MINUTES[spec.role] * MINUTE_MS,
        commits: false,
        phase: null,
        prompt,
      },
      hooksOf(cfg, dir, repo),
    );
    const result = resultOf(raw, spec.schema);
    if (!result.ok) {
      throw new OpsError(`the ${run.task} session failed: ${result.error}`);
    }
    return spec.schema.parse(result.reply);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

export type { SessionSpec };
export { readOnlySession };
