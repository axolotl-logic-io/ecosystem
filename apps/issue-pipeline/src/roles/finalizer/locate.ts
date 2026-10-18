// Where a finalizer run starts, and what it carries: the issue's saved state,
// its hand-off fields and event log, how far its rebase and retest got, and
// the gate: an open blocking finding stops the run before any step. Every
// start, an old `merge` state saved by the sweep's stage code included,
// begins at the first step, since every step is safe to run again
// (`every-role-resumes`): the sweep's `phase` and `carry` are ignored, and
// the steps a retest has already passed are skipped. Pure.

import type { State } from "../../state.ts";
import { stopFor } from "../../stops.ts";
import { findingsStop, openFindings } from "../../workflow/findings.ts";
import type { PromptItem } from "../../workflow/prompts.ts";
import type { Signature } from "../../workflow/signing.ts";
import type { FixOutput } from "../../workflow/stages/checks-reply.ts";
import type { ResolverSettings } from "../../workflow/stages/conflict-resolver.ts";
import { isIssueState } from "../../workflow/stages/entry-replies.ts";
import type { StackedOn } from "../../workflow/stages/stacked.ts";
import type { Continuations, IssueState } from "../../workflow/types.ts";
import type { End, MachineState } from "../machine.ts";
import type { RoleContext } from "../walk.ts";

// The wiki's rebase stopped on conflicts in `files`, onto its `branch`.
interface WikiConflict {
  files: string[];
  baseSha: unknown;
  branch: string;
}

// Where the conflict resolver is: not run yet, handed off to a continuation
// on the same rebase, or done with its reply (null when the session failed
// or its reply didn't fit) and the session's error.
type Resolution =
  | { kind: "none" }
  | { kind: "continuing" }
  | { kind: "settled"; fix: FixOutput | null; error: string | null };

// How far the rebase and retest before the merge got (#422): not begun, the
// rebase due (saved as the `rebaseOf` checkpoint before it runs, so a
// restart after its push rebases no further), the rebased head's tests or
// its CI due, or the retested head ready to merge.
type Retest = "none" | "rebase" | "verify" | "ci" | "merge";

// A comment for the issue's PR, keyed so a restart edits it rather than
// posting it again. It rides on the next op's request (`comments`).
interface PrComment {
  number: number;
  by: Signature;
  body: string;
  key: string;
}

interface FinalizerData {
  issue: number;
  // When the run started, which stamps its event-log lines.
  at: Date;
  // The issue's saved state as the run found it.
  st: IssueState;
  item: PromptItem;
  settings: ResolverSettings;
  jobId: string;
  mergeQueue: readonly number[] | null;
  // The hand-off fields the run writes back.
  log: string[];
  conflictFixes: number;
  continuations: Continuations | number;
  passedSha: string | null;
  // The branch's head, the head local verification passed and its summary,
  // whether the head is a clean rebase of a passed head whose tests run
  // again (cleared once it merges or leaves merge), the rebases counted
  // toward maxSyncs and what the branch is stacked on.
  headSha: string | null;
  verifiedSha: string | null;
  verifySummary: string;
  testsOnly: boolean;
  syncs: number;
  stackedOn: StackedOn | null;
  // The verified head being rebased, a checkpoint; null once the rebase
  // replied.
  rebaseOf: string | null;
  retest: Retest;
  conflict: WikiConflict | null;
  resolution: Resolution;
  comments: PrComment[];
  // How the run ends, once a step has decided it.
  end: End | null;
}

// The stop the gate or a step decides: `code` is the stop code (src/stops.ts),
// or null for the one the reason names.
interface FinalizerStop {
  code: string | null;
  reason: string;
  detail: string | null;
}

// The stop's end, which the `stop` op carries out on GitHub.
function stopEnd(issue: number, stop: FinalizerStop): End {
  const { reason, detail } = stop;
  const code = stop.code ?? stopCodeOf(reason);
  const payload = { number: issue, code, reason, detail };
  return { kind: "stopped", code, after: { op: "stop", payload } };
}

// The stop code `reason` names, as the stop op reads it.
function stopCodeOf(reason: string): string {
  return stopFor(reason)?.code ?? "error";
}

// The issue's state with the run's hand-off fields: what the ops it sends
// read as `state`.
function stateOf(data: FinalizerData): IssueState {
  const { st, log, conflictFixes, continuations, passedSha } = data;
  const { headSha, verifiedSha, verifySummary, testsOnly, syncs } = data;
  return {
    ...st,
    log,
    conflictFixes,
    continuations,
    passedSha,
    headSha,
    verifiedSha,
    verifySummary,
    testsOnly,
    syncs,
    stackedOn: data.stackedOn,
  };
}

// Where the saved state leaves the retest: a clean rebase's head is retested
// from its tests, or from its CI once they passed at it; a rebase saved as
// begun at the verified head goes on; otherwise none has begun.
function retestOf(
  st: IssueState,
  rebaseOf: unknown,
): "none" | "rebase" | "verify" | "ci" {
  const { testsOnly, headSha, verifiedSha } = st;
  if (testsOnly === true) {
    if (typeof verifiedSha === "string" && verifiedSha === headSha) {
      return "ci";
    }
    return "verify";
  }
  if (typeof rebaseOf === "string" && rebaseOf === verifiedSha) {
    return "rebase";
  }
  return "none";
}

// The verified head a due rebase rebases, or null when none is due.
function rebaseOfAt(st: IssueState, retest: Retest): string | null {
  if (retest !== "rebase") {
    return null;
  }
  return st.verifiedSha ?? null;
}

// Starts every run at the first step, with the gate's stop as its end when
// a blocking finding is open.
function locate(
  saved: State,
  context: RoleContext,
): MachineState<string, FinalizerData> {
  const { rebaseOf } = saved.checkpoints ?? {};
  if (!isIssueState(saved)) {
    throw new Error("finalizer: the saved state is not an issue's state");
  }
  const { issue, jobId, cfg, budgets, models, paths, now, mergeQueue } =
    context;
  let committer: ResolverSettings["committer"] = "git";
  if (paths.job !== undefined) {
    committer = "pipeline_commit";
  }
  const retest = retestOf(saved, rebaseOf);
  let end: End | null = null;
  if (openFindings({ st: saved }).length > 0) {
    const base = "open blocking findings remain at merge time";
    end = stopEnd(issue, findingsStop(cfg, { st: saved }, base));
  }
  const data: FinalizerData = {
    issue,
    at: now,
    st: saved,
    item: { n: issue, paths },
    settings: { cfg, budgets, models, committer },
    jobId,
    mergeQueue,
    log: saved.log ?? [],
    conflictFixes: saved.conflictFixes ?? 0,
    continuations: saved.continuations ?? {},
    passedSha: saved.passedSha ?? null,
    headSha: saved.headSha ?? null,
    verifiedSha: saved.verifiedSha ?? null,
    verifySummary: saved.verifySummary ?? "",
    testsOnly: saved.testsOnly === true,
    syncs: saved.syncs ?? 0,
    stackedOn: saved.stackedOn ?? null,
    rebaseOf: rebaseOfAt(saved, retest),
    retest,
    conflict: null,
    resolution: { kind: "none" },
    comments: [],
    end,
  };
  return { at: "wiki-sync", data };
}

export type {
  FinalizerData,
  FinalizerStop,
  PrComment,
  Resolution,
  Retest,
  WikiConflict,
};
export { locate, stateOf, stopEnd };
