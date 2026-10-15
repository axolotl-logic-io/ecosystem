// The steps a stage returns: launch more, finish, or finish by stopping work
// on the issue.

import type {
  ChildResult,
  Launch,
  LaunchResult,
  StageComment,
  StageState,
  Step,
} from "./types.ts";

// Launch `launches`, after posting `comments`.
function launchStep(
  state: StageState,
  launches: readonly [Launch, ...Launch[]],
  comments: readonly StageComment[] = [],
): Step {
  return { done: false, state, launches, comments, stop: null };
}

// The stage is finished for this sweep, after posting `comments`.
function doneStep(
  state: StageState,
  comments: readonly StageComment[] = [],
): Step {
  return { done: true, state, comments, stop: null };
}

// Stop work on the issue, after posting `comments`.
function stopStep(
  state: StageState,
  reason: string,
  detail: string | null,
  comments: readonly StageComment[] = [],
): Step {
  return { done: true, state, comments, stop: { reason, detail } };
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

export { doneStep, launchStep, onlyChild, onlyReply, stopStep };
