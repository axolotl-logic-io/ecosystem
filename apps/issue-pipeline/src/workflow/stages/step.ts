// The steps a stage returns: launch more, finish, or finish by stopping work
// on the issue.

import { noteEvent } from "../event-log.ts";
import type { Signature } from "../signing.ts";
import type { IssueState } from "../types.ts";
import type {
  ChildResult,
  Launch,
  LaunchResult,
  StageComment,
  StageState,
  StageStop,
  Step,
} from "./types.ts";

// A failed `git … push …` command, as runFailure (src/process.ts) words it:
// the command line, then "exited <code>:" and git's output. A push that timed
// out reads "timed out after" instead, and doesn't match.
const GIT_PUSH_FAILED = /^git .* push .* exited \d+:/u;

// A copy of the issue's saved state that a stage may change, findings
// included, leaving the state it was given as it was.
function copyState(st: IssueState): IssueState {
  return { ...st, findings: st.findings.map((finding) => ({ ...finding })) };
}

// An ops reply's error as a stop's detail.
function replyError(error: unknown): string | null {
  if (typeof error === "string") {
    return error;
  }
  return null;
}

// A signed comment for the issue's PR.
function prComment(by: Signature, body: string): StageComment {
  return { by, body, where: "pr" };
}

// Launch `launches`, after posting `comments`.
function launchStep(
  state: StageState,
  launches: readonly [Launch, ...Launch[]],
  comments: readonly StageComment[] = [],
): Step {
  return { done: false, state, launches, comments, stop: null };
}

// Launch every one of `launches`, which a stage never leaves empty.
function launchEach(
  state: StageState,
  launches: readonly Launch[],
  comments: readonly StageComment[] = [],
): Step {
  const [first, ...rest] = launches;
  if (first === undefined) {
    throw new Error("stage: expected a launch");
  }
  return launchStep(state, [first, ...rest], comments);
}

// Save the issue's state, after posting `comments`. The save is keyed
// "i<n>-save-<seq>", as every save of the sweep is.
function saveStep(
  state: StageState,
  comments: readonly StageComment[] = [],
): Step {
  const payload = { number: state.n, state: state.st };
  return launchStep(
    state,
    [{ kind: "op", name: "save", op: "save-state", payload }],
    comments,
  );
}

// The stage is finished for this sweep, after posting `comments`.
function doneStep(
  state: StageState,
  comments: readonly StageComment[] = [],
): Step {
  return { done: true, again: false, state, comments, stop: null };
}

// The stage is finished for this sweep because `op` hit a network error: the
// issue stays at its stage, and the next sweep runs the stage again.
function deferStep(state: StageState, op: string, now: Date): Step {
  const st = copyState(state.st);
  noteEvent(
    st,
    `deferred: network error during ${op}; will retry next sweep`,
    now,
  );
  return doneStep({ ...state, st });
}

// This round of the stage is finished, after posting `comments`: the sweep
// begins the stage again if the issue is still at it and it fits.
function againStep(
  state: StageState,
  comments: readonly StageComment[] = [],
): Step {
  return { done: true, again: true, state, comments, stop: null };
}

// Stop work on the issue with `stop`, after posting `comments`.
function codedStopStep(
  state: StageState,
  stop: StageStop,
  comments: readonly StageComment[] = [],
): Step {
  return { done: true, again: false, state, comments, stop };
}

// Stop work on the issue, after posting `comments`, under the generic stop
// code.
function stopStep(
  state: StageState,
  reason: string,
  detail: string | null,
  comments: readonly StageComment[] = [],
): Step {
  return codedStopStep(state, { reason, detail, code: null }, comments);
}

// The stage's phase, one of `phases`. Anything else is a bug in the sweep.
function phaseOf<Phase extends string>(
  stage: string,
  phases: readonly Phase[],
  state: StageState,
): Phase {
  const phase = phases.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`${stage}: unknown phase ${state.phase}`);
  }
  return phase;
}

// Whether a failed push op's `error` says git pushed and the remote rejected
// it, rather than that the op failed before or around git's push.
function isPushRejection(error: string | null): boolean {
  return error !== null && GIT_PUSH_FAILED.test(error);
}

// The step after the push op failed with `error`. A rejection stops with
// `rejected` as its reason. Any other failure, such as ops failing to read its
// request, launches the push once more; a second such failure stops as a step
// failure (#263).
function pushFailedStep(
  state: StageState,
  rejected: string,
  error: string | null,
): Step {
  if (isPushRejection(error)) {
    return stopStep(state, rejected, error);
  }
  if (state.phase === "repushed") {
    return codedStopStep(state, {
      reason: "the push op failed again after a retry",
      detail: error,
      code: "error",
    });
  }
  return launchStep({ ...state, phase: "repushed" }, [
    { kind: "op", name: "push", op: "push", payload: { number: state.n } },
  ]);
}

// The result of the session a step launched alone. Anything else is a bug in
// the sweep's loop.
function onlyChild(results: readonly LaunchResult[]): ChildResult {
  const [result] = results;
  if (results.length !== 1 || result?.kind !== "child") {
    throw new Error("stage: expected the result of one session");
  }
  return result;
}

// The results of the sessions a step launched, one for each of `names`, each
// paired with its name. Anything else is a bug in the sweep's loop.
function sessionsOf<Name>(
  names: readonly Name[],
  results: readonly LaunchResult[],
): { name: Name; result: ChildResult }[] {
  return names.map((name, index) => {
    const result = results[index];
    if (results.length !== names.length || result?.kind !== "child") {
      throw new Error("stage: expected the result of each session");
    }
    return { name, result };
  });
}

// The reply to the ops request a step launched alone. Anything else is a bug
// in the sweep's loop.
function onlyReply(
  results: readonly LaunchResult[],
): Readonly<Record<string, unknown>> {
  const [result] = results;
  if (results.length !== 1 || result?.kind !== "op") {
    throw new Error("stage: expected the reply to one ops request");
  }
  return result.reply;
}

export {
  againStep,
  codedStopStep,
  copyState,
  deferStep,
  doneStep,
  launchEach,
  launchStep,
  onlyChild,
  onlyReply,
  phaseOf,
  prComment,
  pushFailedStep,
  replyError,
  saveStep,
  sessionsOf,
  stopStep,
};
