// What every Sync task op (#184) checks before it touches the checkout, read
// fresh each time (`fresh-reads`): the binding is a current Sync binding of
// this issue, no Land is armed or uncertain, and the code is still writable.
// A refusal leaves the checkout, the branch and the records as they were.

import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { fetchIn } from "../git-state.ts";
import { OpsError } from "../ops-error.ts";
import type { Binding, Row } from "../task-result-records.ts";
import { requestedBinding } from "../task-result-records.ts";
import { taskRecords, unsettledAttempts } from "../task-results.ts";
import { readWriteAuthority } from "../write-authority.ts";
import type { RevisionBinding } from "./task-gate.ts";
import {
  assertCurrentRevision,
  contains,
  isRevisionBinding,
} from "./task-gate.ts";

// A Sync binding: revision R and the literal target commit T.
type SyncBinding = RevisionBinding & { task: "Sync" };

function isSyncBinding(binding: Binding): binding is SyncBinding {
  return binding.task === "Sync" && isRevisionBinding(binding);
}

function refuse(reason: string): never {
  throw new OpsError(`Sync refused: ${reason}`);
}

// Every check a Sync op makes before a writer effect, and the issue's
// records as read. T must be on the configured target.
function syncGate(
  cfg: Config,
  number: number,
  requested: Binding,
): { binding: SyncBinding; rows: Row[]; wt: string } {
  const binding = requestedBinding(cfg, number, requested);
  if (!isSyncBinding(binding)) {
    refuse("the binding is not a Sync binding of a revision");
  }
  const rows = taskRecords(cfg, number, listComments(cfg, number));
  const land = unsettledAttempts(rows, "Land");
  if (land.length > 0) {
    refuse(
      `Land run ${land[0]?.run.id} is armed or uncertain; reconcile it read-only before any writer`,
    );
  }
  if (!readWriteAuthority(cfg, number).codeWritable) {
    refuse(
      "the code is not writable: merged, attempted, or rejected by Security",
    );
  }
  assertCurrentRevision(cfg, number, binding, refuse);
  const wt = paths.worktree(cfg, number);
  fetchIn(cfg, wt, cfg.baseBranch);
  const { commit } = binding.target;
  if (!contains(wt, `origin/${cfg.baseBranch}`, commit)) {
    refuse(`target ${commit} is not on ${cfg.baseBranch}`);
  }
  return { binding, rows, wt };
}

export type { SyncBinding };
export { refuse, syncGate };
