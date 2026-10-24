// The confirm-merged op: read-only post-Land confirmation (#185). Checks and
// Security clear the exact candidate before the target moves; after Land
// this confirms only that the signed fast-forward intent binds the result to
// that checked candidate, then GitHub's same-PR MERGED receipt, the result's
// ancestry on the fetched base and its exact delivered graph. It runs no
// checks and writes no state. A result without that proof is refused, never
// re-verified: a postmerge suite would be evidence the merge never had.

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { parseRequest } from "../process.ts";
import { readWriteState } from "../saved-state.ts";
import type { CodeMerged, IssueState } from "../state.ts";
import { sameRevision } from "../state.ts";
import { BINDING } from "../task-result-records.ts";
import { landDeliveryRefusal } from "./land-task.ts";
import { confirmedMergedParent } from "./merged-graph.ts";

const REQUEST = z.looseObject({
  number: z.number().int().positive(),
  codeMerged: z.object({
    pr: z.number().int().positive(),
    sha: z.string().min(1),
  }),
  // The task-result path (#185, inactive until #186): Completion also
  // consumes the exact passed Land result of this binding.
  binding: BINDING.optional(),
});

type ConfirmedReply =
  | { confirmed: true; headSha: string; parent: string }
  | { confirmed: false; reason: string };

// Why the signed state holds no exact premerge proof for `codeMerged`, or
// null when it does: a fast-forward intent for exactly this PR and result,
// its receipt, and the deterministic checks saved for exactly that commit.
function premergeProofRefusal(
  state: IssueState,
  codeMerged: CodeMerged,
): string | null {
  const attempt = state.mergeAttempt;
  if (attempt === null || attempt.operation === undefined) {
    return `no signed fast-forward intent binds ${codeMerged.sha} to a checked candidate (an external, manual or legacy two-parent merge)`;
  }
  if (
    attempt.pr !== codeMerged.pr ||
    attempt.authorized.code !== codeMerged.sha ||
    state.merged === null ||
    !sameRevision(state.merged, attempt.authorized)
  ) {
    return `the signed fast-forward intent and receipt do not bind PR #${codeMerged.pr} merged as ${codeMerged.sha}`;
  }
  if (state.verifiedSha !== codeMerged.sha) {
    return `no premerge check proof is saved for exactly ${codeMerged.sha}`;
  }
  return null;
}

function confirmMergedOp(cfg: Config, request: unknown): ConfirmedReply {
  const { number, codeMerged, binding } = parseRequest(
    REQUEST,
    "confirm-merged",
    request,
  );
  const refusal =
    premergeProofRefusal(readWriteState(cfg, number), codeMerged) ??
    (binding && landDeliveryRefusal(cfg, number, binding, codeMerged.sha)) ??
    null;
  if (refusal !== null) {
    return { confirmed: false, reason: refusal };
  }
  const wt = paths.worktree(cfg, number);
  const parent = confirmedMergedParent(cfg, number, wt, codeMerged);
  return { confirmed: true, headSha: codeMerged.sha, parent };
}

export { confirmMergedOp };
