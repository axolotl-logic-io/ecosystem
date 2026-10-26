// Credentialed code writes and writer sessions share one fresh fence. Code of
// a work item stays writable only while no Land may already have delivered
// it: a Land run that is unsettled or passed closes it, since its outcome may
// be on the target. A Land that settled without merging, such as one that
// found the PR conflicting and marked it a draft, leaves it open for Fix.
// Records or saved state that hold throw. Otherwise the item's PR, if it has
// one, must be open.

import { listComments } from "./comments.ts";
import type { Config } from "./config.ts";
import { historicalPrFor } from "./ops/prs.ts";
import { OpsError } from "./ops-error.ts";
import { pullRequest } from "./revision.ts";
import type { StoredWork } from "./saved-state-work.ts";
import { storedWork } from "./saved-state-work.ts";
import type { Records } from "./tasks/records.ts";
import { determined, isAttempt, readRecords } from "./tasks/records.ts";

interface WriteAuthority {
  work: StoredWork;
  codeWritable: boolean;
  // Why code is not writable, when it isn't.
  fence: string | null;
  // The merge commit GitHub reports for the item's merged PR.
  codeLanded: { pr: number; sha: string } | null;
}

// Why the records fence code writes, or null.
function recordFence(records: Records): string | null {
  const { rows } = records;
  const land = rows.filter(isAttempt).find((row) => {
    if (row.binding.task !== "land") {
      return false;
    }
    const settled = determined(rows, row.run.id);
    return settled === undefined || settled.verdict === "passed";
  });
  if (land !== undefined) {
    return `Land record ${String(land.id)} may have delivered this work item`;
  }
  return null;
}

function readWriteAuthority(cfg: Config, issue: number): WriteAuthority {
  const comments = listComments(cfg, issue);
  const work = storedWork(cfg, issue, comments);
  const fence = recordFence(readRecords(cfg, issue, comments));
  if (fence !== null) {
    return { work, codeWritable: false, fence, codeLanded: null };
  }
  let pr = historicalPrFor(cfg, issue);
  if (work.kind === "current" && work.state.pr !== null) {
    ({ pr } = work.state);
  }
  if (pr === null) {
    return { work, codeWritable: true, fence: null, codeLanded: null };
  }
  const current = pullRequest(cfg, issue, pr);
  if (current.state === "MERGED" && current.mergeCommit !== null) {
    return {
      work,
      codeWritable: false,
      fence: `PR #${pr} merged`,
      codeLanded: { pr, sha: current.mergeCommit },
    };
  }
  if (current.state === "CLOSED") {
    return {
      work,
      codeWritable: false,
      fence: `PR #${pr} is closed`,
      codeLanded: null,
    };
  }
  if (current.state !== "OPEN") {
    throw new OpsError(
      `PR #${pr} is ${current.state}; code write authority requires an open PR`,
    );
  }
  return { work, codeWritable: true, fence: null, codeLanded: null };
}

export type { WriteAuthority };
export { readWriteAuthority };
