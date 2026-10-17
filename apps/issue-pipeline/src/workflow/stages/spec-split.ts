// Spec's split: the spec writer cuts an issue too big for one session into 2
// to 5 parts, which the split op opens as sub-issues under it (#267). Each
// part's body names the files it touches. A sub-issue can't split again.

import { filesLine } from "../files-line.ts";
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

// The part, its body ending with a line naming its files, if it has any.
function subIssueOf(part: SpecPart): SubIssue {
  const { title, body, after, files } = part;
  if (files.length === 0) {
    return { title, body, after };
  }
  return { title, body: `${body}\n\n${filesLine(files)}`, after };
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
