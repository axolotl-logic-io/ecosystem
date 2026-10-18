// The repo's open issues as the orchestrator's snapshot reads them, after
// checking gh acts as the config's account: every signature and trust check
// assumes it does.

import { z } from "zod";
import { ensureClone } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { gh, ghJson } from "../github.ts";
import { ensureLabels } from "../labels.ts";
import { OpsError } from "../process.ts";

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
  const login = gh(cfg, ["api", "user", "--jq", ".login"]).stdout.trim();
  if (login !== cfg.account) {
    throw new OpsError(
      `gh is logged in as ${login}, but the config's account is ${cfg.account}`,
    );
  }
  ensureLabels(cfg);
  ensureClone(cfg);
  const listed = ghJson(cfg, [
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
