// A work item's task view, read fresh from GitHub and the shared clone: the
// trusted requirements, the current revision R of the item's branch, the
// configured target's tip T, whether R contains T, and the item's
// authenticated v2 results. Evidence that can't be trusted as read holds
// the whole item rather than throwing past the runtime: unreadable or
// contradictory records, historical saved state that is never adopted, and
// an unsettled historical Land.

import type { IssueComment } from "../comments.ts";
import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import type { Revision, TargetState, TaskView } from "../domain.ts";
import { TARGET_STATE } from "../domain.ts";
import { git } from "../github.ts";
import { authorizedIssue, trustedInputsHash } from "../issue-context.ts";
import { OpsError } from "../ops-error.ts";
import { run } from "../process.ts";
import { configPolicyDigest } from "../project-policy.ts";
import type { StoredWork } from "../saved-state-work.ts";
import { storedWork } from "../saved-state-work.ts";
import { landGranted } from "./permissions.ts";
import type { Records } from "./records.ts";
import { RecordsHold, readRecords, taskResults } from "./records.ts";

const WHITESPACE = /\s+/u;
const NO_RECORDS: Records = {
  rows: [],
  historical: {
    landAttempted: false,
    unsettledLand: null,
    refusedSubjects: [],
  },
};

// The view with what an op needs beside it: the checked records and the
// clone the revision was read in.
interface TaskEvidence {
  view: TaskView;
  records: Records;
  work: StoredWork | null;
  clone: string;
  branch: string;
}

// The commit `ref` names on origin exactly, or null when origin has none.
function exactRemote(cfg: Config, clone: string, ref: string): string | null {
  const listed = git(cfg, "dev", ["-C", clone, "ls-remote", "origin", ref]);
  const lines = listed.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  const [line] = lines;
  const [sha, found, extra] = (line ?? "").split(WHITESPACE);
  if (lines.length !== 1 || found !== ref || extra !== undefined) {
    throw new OpsError(`${ref} has no unique exact remote head`);
  }
  return sha ?? null;
}

// The configured target's tip, read exactly.
function readTarget(cfg: Config, clone: string): TargetState {
  const commit = exactRemote(cfg, clone, `refs/heads/${cfg.baseBranch}`);
  return TARGET_STATE.parse({ branch: cfg.baseBranch, commit });
}

// Fetches `branches` into `clone` and requires each of `commits` there: a
// branch that moved past a commit read a moment ago still holds it.
function fetchCommits(
  cfg: Config,
  clone: string,
  branches: readonly string[],
  commits: readonly string[],
): void {
  git(cfg, "dev", [
    "-C",
    clone,
    "fetch",
    "--no-tags",
    "origin",
    ...branches.map(
      (branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ),
  ]);
  for (const commit of commits) {
    if (
      run("git", ["-C", clone, "cat-file", "-e", `${commit}^{commit}`], {
        allowFail: true,
      }).code !== 0
    ) {
      throw new OpsError(`commit ${commit} is not in the fetched branches`);
    }
  }
}

// Whether `ancestor` is reachable from `descendant` in `clone`, where both
// were fetched.
function isAncestor(
  clone: string,
  ancestor: string,
  descendant: string,
): boolean {
  return (
    run(
      "git",
      ["-C", clone, "merge-base", "--is-ancestor", ancestor, descendant],
      {
        allowFail: true,
      },
    ).code === 0
  );
}

function holdOf(records: Records, work: StoredWork | null): string | null {
  if (work?.kind === "historical") {
    return `historical version ${String(work.version)} saved state is never adopted; reconcile it explicitly`;
  }
  if (records.historical.unsettledLand !== null) {
    return `historical Land run ${records.historical.unsettledLand} is unsettled; reconcile it explicitly`;
  }
  return null;
}

function checkedRecords(
  cfg: Config,
  number: number,
  comments: readonly IssueComment[],
): { records: Records; work: StoredWork | null; hold: string | null } {
  try {
    const records = readRecords(cfg, number, comments);
    const work = storedWork(cfg, number, comments);
    return { records, work, hold: holdOf(records, work) };
  } catch (error) {
    if (error instanceof RecordsHold || error instanceof OpsError) {
      return { records: NO_RECORDS, work: null, hold: error.message };
    }
    throw error;
  }
}

// The item's branch: the one the runtime assigned it, which a saved v4
// state must agree with.
function itemBranch(
  cfg: Config,
  number: number,
  work: StoredWork | null,
): string {
  const branch = paths.branch(cfg, number);
  if (
    work?.kind === "current" &&
    work.state.branch !== null &&
    work.state.branch !== branch
  ) {
    throw new OpsError(
      `#${number}'s work is on ${work.state.branch}, not the assigned ${branch}`,
    );
  }
  return branch;
}

function revisionOf(
  cfg: Config,
  clone: string,
  branch: string,
  inputs: string,
): Revision | null {
  const code = exactRemote(cfg, clone, `refs/heads/${branch}`);
  if (code === null) {
    return null;
  }
  return { code, inputs, policy: configPolicyDigest(cfg) };
}

// The item's task evidence, read now in `clone` (an up-to-date clone of the
// configured repository).
function taskEvidence(
  cfg: Config,
  number: number,
  clone: string,
): TaskEvidence {
  const issue = authorizedIssue(cfg, number);
  const comments = listComments(cfg, number);
  const inputs = trustedInputsHash(cfg, issue, comments);
  const { records, work, hold } = checkedRecords(cfg, number, comments);
  const branch = itemBranch(cfg, number, work);
  const target = readTarget(cfg, clone);
  const revision = revisionOf(cfg, clone, branch, inputs);
  let containsTarget = false;
  if (revision !== null) {
    fetchCommits(
      cfg,
      clone,
      [target.branch, branch],
      [target.commit, revision.code],
    );
    containsTarget = isAncestor(clone, target.commit, revision.code);
  }
  return {
    view: {
      workItem: { repo: cfg.repo, number },
      requirements: `sha256:${inputs}`,
      revision,
      target,
      containsTarget,
      results: taskResults(records.rows),
      hold,
      permissions: { land: landGranted(cfg) },
    },
    records,
    work,
    clone,
    branch,
  };
}

export type { TaskEvidence };
export { exactRemote, fetchCommits, isAncestor, readTarget, taskEvidence };
