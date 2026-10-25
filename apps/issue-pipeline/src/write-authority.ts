// Credentialed code writes and writer sessions share one fresh fence. Code
// of a work item stays writable only while nothing irreversible or refused
// binds it: any Land attempt (v2, or v1 history) closes it for good, since
// a Land's outcome may already be on the target; a refused Review Security
// subject (v2, or a v1 Security refusal) closes it, so writers can't reroll
// a refusal; and historical saved state (versions 1 to 3) is never adopted,
// so its work is preserved locally rather than written. Records that hold
// throw. Otherwise the item's PR, if it has one, must be open.

import { listComments } from "./comments.ts";
import type { Config } from "./config.ts";
import { historicalPrFor } from "./ops/prs.ts";
import { OpsError } from "./ops-error.ts";
import { pullRequest } from "./revision.ts";
import type { StoredWork } from "./saved-state-work.ts";
import { storedWork } from "./saved-state-work.ts";
import type { Records } from "./tasks/records.ts";
import { isAttempt, isResult, readRecords } from "./tasks/records.ts";

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
  const { rows, historical } = records;
  const land = rows.find(
    (row) => isAttempt(row) && row.binding.task === "land",
  );
  if (land !== undefined) {
    return `Land record ${String(land.id)} was attempted for this work item`;
  }
  if (historical.landAttempted) {
    return "a historical Land was attempted for this work item";
  }
  const refusal = rows.find(
    (row) =>
      isResult(row) &&
      row.binding.task === "review-security" &&
      row.verdict === "refused",
  );
  if (refusal !== undefined || historical.refusedSubjects.length > 0) {
    return `Review Security refused this work item's code (${String(refusal?.id ?? "historical")})`;
  }
  return null;
}

function stateFence(work: StoredWork): string | null {
  if (work.kind === "historical") {
    return `historical version ${String(work.version)} state is never adopted; reconcile it explicitly`;
  }
  return null;
}

function readWriteAuthority(cfg: Config, issue: number): WriteAuthority {
  const comments = listComments(cfg, issue);
  const work = storedWork(cfg, issue, comments);
  const fence =
    stateFence(work) ?? recordFence(readRecords(cfg, issue, comments));
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
