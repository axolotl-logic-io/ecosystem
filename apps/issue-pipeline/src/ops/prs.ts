// The issue branch's pull request on GitHub.

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { ghJson } from "../github.ts";

// `gh pr list --json number`'s rows, or null when gh printed nothing.
const PR_ROWS = z.array(z.looseObject({ number: z.number() })).nullable();

// The number of the open PR from issue `n`'s branch, or undefined when it has
// none.
function openPrFor(cfg: Config, n: number): number | undefined {
  const listed = ghJson(cfg, [
    "pr",
    "list",
    "-R",
    cfg.repo,
    "--head",
    paths.branch(n),
    "--state",
    "open",
    "--json",
    "number",
  ]);
  const [first] = PR_ROWS.parse(listed) ?? [];
  return first?.number;
}

export { openPrFor };
