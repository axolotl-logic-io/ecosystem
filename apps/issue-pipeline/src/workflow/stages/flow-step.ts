// The step every stage takes after ops pushed or rebased the code branch:
// it saves the issue's flows from the reply (flows.ts), then stops when the
// work changed nothing, closes the draft PR of a change that lives only in
// the wiki, reopens it when code comes back, or goes straight on.

import type { Flows } from "../flows.ts";
import { flowsOf, prFlowAction } from "../flows.ts";
import {
  doneStep,
  launchStep,
  onlyReply,
  replyError,
  stopStep,
} from "./step.ts";
import type {
  LaunchResult,
  OpLaunch,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// How a stage goes on once the PR is as its flows need, posting `comments`.
type GoOn = (
  state: StageState,
  ctx: StageContext,
  comments: readonly StageComment[],
) => Step;

// The phase that reads a close-pr or open-pr reply, how the stage goes on,
// and the comments to post with the next step.
interface FlowNext {
  phase: string;
  goOn: GoOn;
  comments?: readonly StageComment[];
}

const NOTHING_CHANGED = "the implementation changed nothing";

// The flows a push or rebase reply reports. A reply without them is read as
// a code change with no wiki commits, the pipeline's flow before flows.
function flowsFrom(reply: Readonly<Record<string, unknown>>): Flows {
  const { codeChanged, wikiAhead } = reply;
  let ahead = 0;
  if (typeof wikiAhead === "number") {
    ahead = wikiAhead;
  }
  return flowsOf({ codeChanged: codeChanged !== false, wikiAhead: ahead });
}

// The op that closes or reopens the issue's PR.
function prLaunch(state: StageState, action: "close" | "reopen"): OpLaunch {
  const { st, n } = state;
  if (action === "close") {
    const payload = { number: n, pr: st.pr };
    return { kind: "op", name: "closepr", op: "close-pr", payload };
  }
  const { prTitle, prBody, prBy, pr } = st;
  const payload = { number: n, title: prTitle, body: prBody, by: prBy };
  return {
    kind: "op",
    name: "openpr",
    op: "open-pr",
    payload: { ...payload, reopen: pr },
  };
}

// Saves the flows `reply` reports, then acts on them, posting `comments`: a
// stop, a close-pr or open-pr launch whose reply `phase` reads (through
// prFlowed), or `goOn`.
function flowStep(
  state: StageState,
  ctx: StageContext,
  reply: Readonly<Record<string, unknown>>,
  { phase, goOn, comments = [] }: FlowNext,
): Step {
  const flows = flowsFrom(reply);
  const st = { ...state.st, flows };
  const saved = { ...state, st };
  const action = prFlowAction(flows, st.prClosed === true);
  switch (action) {
    case "stop":
      return stopStep(saved, NOTHING_CHANGED, null, comments);
    case "close":
    case "reopen":
      return launchStep(
        { ...saved, phase },
        [prLaunch(saved, action)],
        comments,
      );
    case "go":
      return goOn(saved, ctx, comments);
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}

// Ends the stage, posting `comments`.
function ended(
  state: StageState,
  _ctx: StageContext,
  comments: readonly StageComment[],
): Step {
  return doneStep(state, comments);
}

// Like flowStep, for a stage that ends once the PR is as its flows need: a
// close or reopen is read in its "flowed" phase (prFlowed with ended).
function flowEnd(
  state: StageState,
  ctx: StageContext,
  reply: Readonly<Record<string, unknown>>,
  comments: readonly StageComment[],
): Step {
  const next = { phase: "flowed", goOn: ended, comments };
  return flowStep(state, ctx, reply, next);
}

// Records what close-pr or open-pr did to the PR, then goes on.
function prFlowed(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
  goOn: GoOn = ended,
): Step {
  const { ok, error, closed, pr, headSha } = onlyReply(results);
  if (ok === true && closed === true) {
    return goOn({ ...state, st: { ...state.st, prClosed: true } }, ctx, []);
  }
  if (ok !== true || typeof pr !== "number") {
    const reason = "could not close or reopen the PR";
    return stopStep(state, reason, replyError(error));
  }
  const st = { ...state.st, pr, prClosed: false };
  if (typeof headSha === "string") {
    st.headSha = headSha;
  }
  return goOn({ ...state, st }, ctx, []);
}

export { flowEnd, flowStep, prFlowed };
