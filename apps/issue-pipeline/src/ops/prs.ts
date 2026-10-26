// The issue branch's pull request on GitHub.

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { ghJson } from "../github.ts";
import { OpsError } from "../ops-error.ts";

// One row of `gh pr list --json number,mergeCommit`: an unmerged PR's merge
// commit is null.
const PR_ROW = z.looseObject({
  number: z.number(),
  mergeCommit: z.looseObject({ oid: z.string().min(1) }).nullish(),
});
// The rows, or null when gh printed nothing.
const PR_ROWS = z.array(PR_ROW).nullable();

type PrRow = z.infer<typeof PR_ROW>;

// A full result is unproven at the API bound. Never choose a newest match or
// hide a retarget by filtering on the expected base during discovery.
const HISTORY_LIMIT = 100;
const HISTORY = z.array(z.object({ number: z.number().int().positive() }));

function historicalPrFor(cfg: Config, n: number): number | null {
  const rows = HISTORY.parse(
    ghJson(cfg, "landing", [
      "pr",
      "list",
      "-R",
      cfg.repo,
      "--head",
      paths.branch(cfg, n),
      "--state",
      "all",
      "--limit",
      String(HISTORY_LIMIT),
      "--json",
      "number",
    ]),
  );
  if (rows.length >= HISTORY_LIMIT || rows.length > 1) {
    throw new OpsError(`#${n}'s PR history is saturated or ambiguous`);
  }
  return rows[0]?.number ?? null;
}

// The first PR from issue `n`'s branch in `state`, or undefined when it has
// none.
function prFor(cfg: Config, n: number, state: string): PrRow | undefined {
  const listed = ghJson(cfg, "landing", [
    "pr",
    "list",
    "-R",
    cfg.repo,
    "--head",
    paths.branch(cfg, n),
    "--state",
    state,
    "--json",
    "number,mergeCommit",
  ]);
  const [first] = PR_ROWS.parse(listed) ?? [];
  return first;
}

// The number of the open PR from issue `n`'s branch, or undefined when it has
// none.
function openPrFor(cfg: Config, n: number): number | undefined {
  return prFor(cfg, n, "open")?.number;
}

export { historicalPrFor, openPrFor };
