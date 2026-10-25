// The work item's one pull request, which a writer task opens once its code
// is pushed (`open-task-pr`): the open PR from the item's branch if there is
// one, else a new ready PR that closes the issue. The development account
// opens it; the item's version 4 state records its number as an
// observation. A lost create reply is reconciled by finding the PR the
// branch names, never by creating another.

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { gh, ghJson } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import {
  newWorkState,
  readWorkState,
  withWorkLog,
  writeWorkState,
} from "../saved-state-work.ts";
import { readWriteAuthority } from "../write-authority.ts";
import { openPrFor } from "./prs.ts";

const REQUEST = z.looseObject({ number: z.number().int().positive() });
const ISSUE = z.looseObject({ title: z.string().min(1) });

function titleFor(n: number, title: string): string {
  if (new RegExp(`#${n}\\b`, "u").test(title)) {
    return title;
  }
  return `${title} (#${n})`;
}

function createPr(cfg: Config, n: number): void {
  const { title } = ISSUE.parse(
    ghJson(cfg, "landing", ["api", `repos/${cfg.repo}/issues/${n}`]),
  );
  gh(
    cfg,
    "dev",
    [
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
    ],
    { reconciles: true },
  );
}

function recordPr(cfg: Config, n: number, pr: number): void {
  const stored = readWorkState(cfg, n);
  if (stored.kind === "historical") {
    throw new OpsError(`#${n}'s historical state is never adopted`);
  }
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
  const { number } = parseRequest(REQUEST, "open-task-pr", request);
  const authority = readWriteAuthority(cfg, number);
  if (!authority.codeWritable) {
    throw new OpsError(
      `#${number}'s code is not writable: ${authority.fence ?? "fenced"}`,
    );
  }
  let pr = openPrFor(cfg, number);
  if (pr === undefined) {
    createPr(cfg, number);
    pr = openPrFor(cfg, number);
  }
  if (pr === undefined) {
    throw new OpsError(
      `#${number}'s PR is uncertain; reconcile by reading before any retry`,
    );
  }
  recordPr(cfg, number, pr);
  return { pr };
}

export { openTaskPr };
