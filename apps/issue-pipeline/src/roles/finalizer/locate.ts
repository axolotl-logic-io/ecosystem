// Where a finalizer run starts, and what it carries: the issue's saved state,
// its hand-off fields and event log, and the gate: an open blocking finding
// stops the run before any step. Every start, an old `merge` state saved by
// the sweep's stage code included, begins at the first step, since every step
// is safe to run again (`every-role-resumes`): the sweep's `phase` and
// `carry` are ignored. Pure.

import type { State } from "../../state.ts";
import { stopFor } from "../../stops.ts";
import { findingsStop, openFindings } from "../../workflow/findings.ts";
import type { PromptItem } from "../../workflow/prompts.ts";
import type { Signature } from "../../workflow/signing.ts";
import type { FixOutput } from "../../workflow/stages/checks-reply.ts";
import type { ResolverSettings } from "../../workflow/stages/conflict-resolver.ts";
import { isIssueState } from "../../workflow/stages/entry-replies.ts";
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
  return { ...st, log, conflictFixes, continuations, passedSha };
}

// Starts every run at the first step, with the gate's stop as its end when
// a blocking finding is open.
function locate(
  saved: State,
  context: RoleContext,
): MachineState<string, FinalizerData> {
  if (!isIssueState(saved)) {
    throw new Error("finalizer: the saved state is not an issue's state");
  }
  const { issue, jobId, cfg, budgets, models, paths, now, mergeQueue } =
    context;
  let committer: ResolverSettings["committer"] = "git";
  if (paths.job !== undefined) {
    committer = "pipeline_commit";
  }
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
  WikiConflict,
};
export { locate, stateOf, stopEnd };
