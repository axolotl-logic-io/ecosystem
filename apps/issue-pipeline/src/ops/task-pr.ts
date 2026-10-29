// The issue has one PR, reused across attempts. Implement publishes it as a
// draft before its model session and marks it ready after hardening. An empty
// initial commit gives GitHub a branch ahead of base before code is written.

import { z } from "zod";
import { pushHead } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { assertClean, gitIn } from "../git-state.ts";
import { gh, ghJson } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest, run } from "../process.ts";
import { pullRequest } from "../revision.ts";
import {
  newWorkState,
  readWorkState,
  withWorkLog,
  writeWorkState,
} from "../saved-state-work.ts";
import { readWriteAuthority } from "../write-authority.ts";
import { openPrFor } from "./prs.ts";

const REQUEST = z.looseObject({
  number: z.number().int().positive(),
  draft: z.boolean().default(false),
});
const ISSUE = z.looseObject({ title: z.string().min(1) });
const COMMIT_ENV: ReadonlyMap<string, string> = new Map([
  ["ISSUE_PIPELINE_COMMIT", "1"],
  ["GIT_EDITOR", "true"],
]);

function titleFor(n: number, title: string): string {
  if (new RegExp(`#${n}\\b`, "u").test(title)) {
    return title;
  }
  return `${title} (#${n})`;
}

function createPr(cfg: Config, n: number, draft: boolean): void {
  const { title } = ISSUE.parse(
    ghJson(cfg, "landing", ["api", `repos/${cfg.repo}/issues/${n}`]),
  );
  const args = [
    "pr",
    "create",
    "-R",
    cfg.repo,
    "--base",
    cfg.baseBranch,
    "--head",
    paths.branch(cfg, n),
    "--title",
    titleFor(n, title),
    "--body",
    `Closes #${n}`,
  ];
  if (draft) {
    args.push("--draft");
  }
  gh(cfg, "dev", args, { reconciles: true });
}

/** Publish a new branch without changing files or replacing earlier work. */
function publishBranch(cfg: Config, number: number): void {
  const dir = paths.worktree(cfg, number);
  assertClean(dir);
  const ahead = Number(
    gitIn(dir, [
      "rev-list",
      "--count",
      `origin/${cfg.baseBranch}..HEAD`,
    ]).trim(),
  );
  if (ahead === 0) {
    run(
      "git",
      ["-C", dir, "commit", "--allow-empty", "-m", `Start work on #${number}`],
      { env: COMMIT_ENV },
    );
  }
  pushHead(cfg, number, "open-task-pr");
}

function recordPr(cfg: Config, n: number, pr: number): void {
  const stored = readWorkState(cfg, n);
  let state = newWorkState(n);
  if (stored.kind === "current") {
    ({ state } = stored);
  }
  if (state.pr === pr) {
    return;
  }
  writeWorkState(
    cfg,
    withWorkLog(
      {
        ...state,
        action: cfg.execution?.instance ?? state.action,
        branch: paths.branch(cfg, n),
        pr,
      },
      `PR #${pr} opened`,
      new Date(),
    ),
  );
}

function openTaskPr(cfg: Config, request: unknown): { pr: number } {
  const { number, draft } = parseRequest(REQUEST, "open-task-pr", request);
  const authority = readWriteAuthority(cfg, number);
  if (!authority.codeWritable) {
    throw new OpsError(
      `#${number}'s code is not writable: ${authority.fence ?? "fenced"}`,
    );
  }
  let pr = openPrFor(cfg, number);
  if (pr === undefined) {
    if (draft) {
      publishBranch(cfg, number);
    }
    createPr(cfg, number, draft);
    pr = openPrFor(cfg, number);
  }
  if (pr === undefined) {
    throw new OpsError(
      `#${number}'s PR is uncertain; reconcile by reading before any retry`,
    );
  }
  const current = pullRequest(cfg, number, pr);
  if (current.draft !== draft) {
    const args = ["pr", "ready", String(pr), "-R", cfg.repo];
    if (draft) {
      args.push("--undo");
    }
    gh(cfg, "dev", args, { reconciles: true });
    if (pullRequest(cfg, number, pr).draft !== draft) {
      throw new OpsError(`#${number}'s PR draft status is uncertain`);
    }
  }
  recordPr(cfg, number, pr);
  return { pr };
}

export { openTaskPr };
