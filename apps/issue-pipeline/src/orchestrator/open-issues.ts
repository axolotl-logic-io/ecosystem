// The repo's open issues as the orchestrator's snapshot reads them, after
// authenticating each operation as its explicit development or merge identity.

import { z } from "zod";
import { ensureClone } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { ghJson } from "../github.ts";
import { ensureLabels } from "../labels.ts";

const ISSUE_LIST_LIMIT = 300;

// A row of `gh issue list`.
const ISSUE_ROW = z.looseObject({
  author: z.looseObject({ login: z.string().nullish() }).nullish(),
  body: z.string().nullish(),
  createdAt: z.string(),
  labels: z.array(z.looseObject({ name: z.string() })),
  number: z.number(),
  title: z.string(),
});

// The rows, or null when gh printed nothing.
const ISSUE_ROWS = z.array(ISSUE_ROW).nullable();

type IssueRow = z.infer<typeof ISSUE_ROW>;

function openIssues(cfg: Config): IssueRow[] {
  ensureLabels(cfg);
  ensureClone(cfg);
  const listed = ghJson(cfg, "merge", [
    "issue",
    "list",
    "-R",
    cfg.repo,
    "--state",
    "open",
    "--limit",
    String(ISSUE_LIST_LIMIT),
    "--json",
    "number,title,author,labels,createdAt,body",
  ]);
  return ISSUE_ROWS.parse(listed) ?? [];
}

export type { IssueRow };
export { openIssues };
