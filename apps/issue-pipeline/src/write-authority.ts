// Credentialed writes and session scopes share one fresh authority boundary.
// Saved merge receipts close code authority permanently for that work; a
// confirmed live merge closes the interval before its receipt is saved. The
// live receipt is returned only for wiki checks, never written back as state.
import { assignedBranch } from "./branch-binding.ts";
import type { Config } from "./config.ts";
import { OpsError } from "./process.ts";
import { pullRequest } from "./revision.ts";
import { readWriteState } from "./saved-state.ts";
import type { CodeMerged, IssueState } from "./state.ts";

function readWriteAuthority(
  cfg: Config,
  issue: number,
): { state: IssueState; codeWritable: boolean; codeMerged: CodeMerged | null } {
  const state = readWriteState(cfg, issue);
  assignedBranch(cfg, issue, state);
  const { codeMerged, merged, pr } = state;
  if (codeMerged !== null || (merged !== null && merged.code !== null)) {
    return { state, codeWritable: false, codeMerged };
  }
  if (pr === null) {
    return { state, codeWritable: true, codeMerged: null };
  }
  const current = pullRequest(cfg, issue, pr);
  if (current.state === "MERGED" && current.mergeCommit !== null) {
    return {
      state,
      codeWritable: false,
      codeMerged: { pr, sha: current.mergeCommit },
    };
  }
  if (current.state !== "OPEN") {
    throw new OpsError(
      `PR #${pr} is ${current.state}; code write authority requires an open PR`,
    );
  }
  return { state, codeWritable: true, codeMerged: null };
}

export { readWriteAuthority };
