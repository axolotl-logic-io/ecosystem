// The issue branch's pull request on GitHub.

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { ghJson } from "../github.ts";

// One row of `gh pr list --json number,mergeCommit`: an unmerged PR's merge
// commit is null.
const PR_ROW = z.looseObject({
  number: z.number(),
  mergeCommit: z.looseObject({ oid: z.string().min(1) }).nullish(),
});
// The rows, or null when gh printed nothing.
const PR_ROWS = z.array(PR_ROW).nullable();

type PrRow = z.infer<typeof PR_ROW>;

// The first PR from issue `n`'s branch in `state`, or undefined when it has
// none.
function prFor(cfg: Config, n: number, state: string): PrRow | undefined {
  const listed = ghJson(cfg, [
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

// The number of a merged PR from issue `n`'s branch, or undefined when it has
// none.
function mergedPrFor(cfg: Config, n: number): number | undefined {
  return prFor(cfg, n, "merged")?.number;
}

// The merge commit of a merged PR from issue `n`'s branch: the base's head
// just after it merged. Undefined when it has none.
function mergeCommitFor(cfg: Config, n: number): string | undefined {
  return prFor(cfg, n, "merged")?.mergeCommit?.oid;
}

export { mergeCommitFor, mergedPrFor, openPrFor };
