// The files each live implementation's branch changes (#390), as the
// orchestrator's file gate reads them: each branch's own changes on GitHub,
// measured from where it was cut, so neither what the base gained since nor
// a stacked prerequisite's changes count. It runs git through the shared
// clone's helpers and touches no files itself, so it needs no Node API.

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { fetchIn } from "../git-state.ts";
import { OpsError, run } from "../process.ts";
import type { StackedOn } from "../stack.ts";
import { measureFrom } from "../stack.ts";
import type { SnapshotIssue } from "./queue.ts";
import { isLiveImplementation } from "./queue.ts";

const LINE_BREAK = /\r?\n/u;

// The paths issue `issue`'s branch on GitHub changes since its merge base with
// what it is measured from (`measureFrom`): the base branch, or the
// prerequisite head it is stacked on. Null when the branch can't be read, as
// when GitHub has no such branch, there is no shared clone, or git fails.
function branchChanges(
  cfg: Config,
  issue: number,
  stackedOn: StackedOn | null,
): string[] | null {
  const clone = paths.clone(cfg);
  const branch = paths.branch(issue);
  const head = `origin/${branch}`;
  try {
    fetchIn(cfg, clone, cfg.baseBranch);
    fetchIn(cfg, clone, `+refs/heads/${branch}:refs/remotes/${head}`);
    const from = measureFrom(stackedOn, cfg);
    const mergeBase = ["-C", clone, "merge-base", from, head];
    const base = run("git", mergeBase).stdout.trim();
    const diff = ["-C", clone, "diff", "--name-only", `${base}..${head}`];
    const listed = run("git", diff).stdout.split(LINE_BREAK);
    return listed.filter((line) => line !== "");
  } catch (error: unknown) {
    if (
      error instanceof OpsError ||
      error instanceof SyntaxError ||
      error instanceof z.ZodError
    ) {
      return null;
    }
    throw error;
  }
}

// Sets `changed` on each live implementation in `issues` to the files its
// branch changes, or null when the branch can't be read. To keep ticks cheap,
// no branch is read when no issue has a stub file a branch could change.
function readBranchChanges(
  cfg: Config,
  issues: readonly SnapshotIssue[],
): void {
  if (!issues.some((issue) => issue.stubs.length > 0)) {
    return;
  }
  for (const issue of issues.filter(isLiveImplementation)) {
    issue.changed = branchChanges(cfg, issue.number, issue.stackedOn);
  }
}

export { readBranchChanges };
