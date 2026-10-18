// The spec writer's end states (the wiki's Pipeline-Roles-Spec-Writer,
// "Lifecycle"): how each finished run ends, and the stop each failure posts.
// An end state routes nowhere, so it answers no result.

import { outOfRoomReason } from "../../workflow/stages/continuation.ts";
import type { End, StateSpec } from "../machine.ts";
import { decided, handoffSummary, refusal } from "./edges.ts";
import type { SpecData, SpecState } from "./locate.ts";
import { FAILED_TWICE, SPEC_ROLE } from "./task.ts";

type EndSpec = StateSpec<SpecState, never, SpecData>;

// The out-of-room stop's code (agent:stopped-too-large).
const TOO_LARGE = "too-large";
// The no-work stop's code (agent:stopped-no-work).
const NO_WORK_CODE = "no-work";

function end(endOf: (data: SpecData) => End): EndSpec {
  return {
    kind: "end",
    effect: (data: SpecData) => ({ kind: "end", end: endOf(data) }),
    on: {},
  };
}

function stopped(data: SpecData, reason: string): End {
  const { issue: number, checkOutput: detail } = data;
  const payload = { number, code: "error", reason, detail };
  return { kind: "stopped", code: "error", after: { op: "stop", payload } };
}

// A handoff with no continuation left: the issue is too large.
function outOfRoom(data: SpecData): End {
  const { issue: number, maxContinuations, settings } = data;
  const reason = outOfRoomReason(SPEC_ROLE, maxContinuations);
  const detail = `Latest handoff: ${settings.paths.handoffFile}\n\n${handoffSummary(data)}`;
  const payload = { number, code: TOO_LARGE, reason, detail };
  return { kind: "stopped", code: TOO_LARGE, after: { op: "stop", payload } };
}

// Back to triage with the session's questions, which the ask posts once the
// issue is saved there, on the state saved, so it keeps their time (#457).
function asked(data: SpecData): End {
  const { questions, spec } = decided(data);
  const payload = { number: data.issue, by: data.by, questions, spec };
  return { kind: "saved", stage: "triage", after: { op: "ask", payload } };
}

const END_STATES: Readonly<
  Record<
    | "released"
    | "split-opened"
    | "asked"
    | "no-work"
    | "pr-opened"
    | "wiki-only"
    | "failed-twice"
    | "split-refused"
    | "out-of-room",
    EndSpec
  >
> = {
  released: end(() => ({ kind: "released" })),
  "split-opened": end(() => ({ kind: "released" })),
  asked: end(asked),
  "no-work": end(() => ({ kind: "stopped", code: NO_WORK_CODE })),
  "pr-opened": end(() => ({ kind: "saved", stage: "implement" })),
  "wiki-only": end(() => ({ kind: "saved", stage: "review" })),
  "failed-twice": end((data: SpecData) => stopped(data, FAILED_TWICE)),
  "split-refused": end((data: SpecData) => stopped(data, refusal(data))),
  "out-of-room": end(outOfRoom),
};

export { END_STATES };
