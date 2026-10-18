// Spec's split: the spec writer cuts an issue too big for two implementer
// sessions into 2 to 5 parts, which the split op opens as sub-issues under it (#267). Each
// part's body goes out as the spec writer wrote it. A sub-issue can't split
// again.

import type { Signature } from "../signing.ts";
import type { SpecPart, SpecReply } from "./build-replies.ts";
import { launchStep, stopStep } from "./step.ts";
import type { StageState, Step } from "./types.ts";

// The fewest parts a split may have.
const MIN_PARTS = 2;

// A part as the split op opens it.
interface SubIssue {
  title: string;
  body: string;
  after: number[];
}

// The part as the split op opens it, its body unchanged.
function subIssueOf(part: SpecPart): SubIssue {
  const { title, body, after } = part;
  return { title, body, after };
}

// Spec's step for a split reply, signed `by`: the split op opens the parts and
// the issue closes for the sweep, its reply read in spec's "follow-up" phase.
// A sub-issue's split, or one with fewer than 2 parts, stops the issue at spec.
function splitStep(state: StageState, reply: SpecReply, by: Signature): Step {
  if (state.st.depth >= 1) {
    return stopStep(state, "a sub-issue can't split again", null);
  }
  if (reply.subIssues.length < MIN_PARTS) {
    return stopStep(
      state,
      "the spec writer's split had fewer than 2 parts",
      null,
    );
  }
  const subIssues = reply.subIssues.map(subIssueOf);
  const payload = { number: state.n, state: state.st, subIssues, by };
  return launchStep(
    { ...state, closed: true, outcome: "split", phase: "follow-up" },
    [{ kind: "op", name: "split", op: "split", payload }],
  );
}

export { splitStep };
