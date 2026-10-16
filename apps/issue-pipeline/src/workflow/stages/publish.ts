// Publish: after the code merged, puts the issue's wiki commits on the wiki
// and finishes the issue, through the publish op. The op rebases them onto
// the wiki's latest version first; a conflict goes to the conflict resolver,
// as a code conflict does (conflicts-never-stop), and the stage publishes
// again once the rebase is resolved. Nothing is saved as a patch. An issue
// whose publish still conflicts, or whose resolution was turned down, stays
// here and retries next sweep, within maxConflictFixes.

import { noteEvent } from "../event-log.ts";
import { wikiOnly } from "../flows.ts";
import { isRecord, syncReplyOf } from "./checks-reply.ts";
import { branchOf } from "./merge-wiki.ts";
import { opFailedStep } from "./network.ts";
import { doneStep, launchStep, onlyReply } from "./step.ts";
import { finishedWiki, resolved, wikiConflicted } from "./sync-conflict.ts";
import type {
  LaunchResult,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// Where publish is: about to publish, reading the publish, waiting for the
// conflict resolver, or waiting for its rebase to finish.
type PublishPhase = "begin" | "published" | "resolved" | "finished";

const PHASES: readonly PublishPhase[] = [
  "begin",
  "published",
  "resolved",
  "finished",
];

function phaseOf(state: StageState): PublishPhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`publish: unknown phase ${state.phase}`);
  }
  return phase;
}

// Asks ops to publish, after posting `comments`; a change that lives only in
// the wiki ends through finish-wiki, as at merge. `retried` is set once a
// resolved conflict has been published again in this sweep.
function publishStep(
  state: StageState,
  comments: readonly StageComment[],
  retried: boolean,
): Step {
  const payload = { number: state.n, state: state.st };
  let op = "publish";
  if (wikiOnly(state.st.flows)) {
    op = "finish-wiki";
  }
  return launchStep(
    { ...state, phase: "published", carry: { retried } },
    [{ kind: "op", name: "publish", op, payload }],
    comments,
  );
}

function republish(state: StageState, comments: readonly StageComment[]): Step {
  return publishStep(state, comments, true);
}

// Whether this sweep already published again after a resolved conflict.
function retriedOf(state: StageState): boolean {
  const { carry } = state;
  if (isRecord(carry)) {
    const { retried } = carry;
    return retried === true;
  }
  return false;
}

// Published: the op has finished the issue. A conflict goes to the resolver,
// once per sweep; any other failure stops, or defers on a network error.
function published(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const raw = onlyReply(results);
  const { ok, published: done } = raw;
  if (ok === true && done === true) {
    const st = { ...state.st, stage: "done" };
    return doneStep({ ...state, st, closed: true, outcome: "merged" });
  }
  const reply = syncReplyOf(raw);
  if (reply.kind === "conflict" && retriedOf(state)) {
    const st = { ...state.st };
    const note = "the wiki moved again while publishing; will retry next sweep";
    noteEvent(st, note, ctx.now());
    return doneStep({ ...state, st });
  }
  if (reply.kind === "conflict") {
    const { conflicts: files, baseSha } = reply;
    const branch = branchOf(raw);
    return wikiConflicted(state, ctx, { files, baseSha, branch });
  }
  let error: string | null = null;
  if (reply.kind === "failed") {
    ({ error } = reply);
  }
  const reason = "could not publish the wiki changes";
  return opFailedStep(state, { op: "publish", reason, error }, ctx.now());
}

// Publish's next step, from its state and the results of its last launches.
function next(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const phase = phaseOf(state);
  switch (phase) {
    case "begin":
      return publishStep(state, [], false);
    case "published":
      return published(state, ctx, results);
    case "resolved":
      return resolved(state, ctx, results);
    case "finished":
      return finishedWiki(state, ctx, results, republish);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
