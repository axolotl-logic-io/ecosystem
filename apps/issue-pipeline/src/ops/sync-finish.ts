// What finish-sync checks a rebase a writer resolved against, before it
// pushes it (sync.ts).

import type { Config } from "../config.ts";
import { run } from "../process.ts";
import { rebaseProblem } from "../rebase.ts";
import type { StackedOn } from "../stack.ts";
import { measureFrom } from "../stack.ts";

// The commit sync-base rebased onto (its reply's baseSha, #279) and what the
// branch is stacked on after that sync.
interface FinishAgainst {
  baseSha?: string | null | undefined;
  stackedOn?: StackedOn | null | undefined;
}

// Why the resolved rebase in `wt` can't be pushed, or undefined when it can.
// A stacked branch is checked against the prerequisite head its sync
// targeted. Otherwise, with a baseSha it is checked against that commit,
// which must be on the base, so a base that moved during the fix doesn't
// throw the resolution away.
function finishProblem(
  cfg: Config,
  wt: string,
  { baseSha, stackedOn }: FinishAgainst,
): string | undefined {
  if (stackedOn !== null && stackedOn !== undefined) {
    return rebaseProblem(wt, measureFrom(stackedOn, cfg));
  }
  const base = `origin/${cfg.baseBranch}`;
  if (baseSha === null || baseSha === undefined || baseSha === "") {
    return rebaseProblem(wt, base);
  }
  const ancestor = ["-C", wt, "merge-base", "--is-ancestor", baseSha, base];
  if (run("git", ancestor, { allowFail: true }).code !== 0) {
    return `${baseSha} is not on ${base}`;
  }
  return rebaseProblem(wt, baseSha);
}

export { finishProblem };
