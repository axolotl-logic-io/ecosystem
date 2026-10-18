// The implementor's end states (the wiki's Pipeline-Roles-Implementor,
// "Lifecycle"): how each finished run ends, and the stop each failure
// posts through the `stop` op. An end state routes nowhere, so it answers
// no result. Pure.

import { outOfRoomReason } from "../../workflow/stages/continuation.ts";
import type { End, StateSpec } from "../machine.ts";
import type { ImplData, ImplState } from "./locate.ts";
import { IMPL_ROLE } from "./locate.ts";

type EndSpec = StateSpec<ImplState, never, ImplData>;

// The stop codes (src/stops.ts): agent:stopped-too-large,
// agent:stopped-not-doable and agent:stopped-error.
const TOO_LARGE = "too-large";
const NOT_DOABLE = "not-doable";
const ERROR = "error";

function end(endOf: (data: ImplData) => End): EndSpec {
  return {
    kind: "end",
    effect: (data: ImplData) => ({ kind: "end", end: endOf(data) }),
    on: {},
  };
}

function stopped(
  data: ImplData,
  code: string,
  stop: { reason: string; detail: string },
): End {
  const payload = { number: data.issue, code, ...stop };
  return { kind: "stopped", code, after: { op: "stop", payload } };
}

function summaryOf(data: ImplData): string {
  return data.reply?.summary ?? "";
}

// A handoff with no continuation left: the issue is too large.
function outOfRoom(data: ImplData): End {
  return stopped(data, TOO_LARGE, {
    reason: outOfRoomReason(IMPL_ROLE, data.maxContinuations),
    detail: `Latest handoff: ${data.settings.paths.handoffFile}\n\n${summaryOf(data)}`,
  });
}

// Saved at review once the issue has a PR, and otherwise at open-pr, whose
// stage opens one.
function implemented(data: ImplData): Extract<End, { kind: "saved" }> {
  if (typeof data.pr === "number") {
    return { kind: "saved", stage: "review" };
  }
  return { kind: "saved", stage: "open-pr" };
}

const END_STATES: Readonly<
  Record<
    | "implemented"
    | "wiki-only"
    | "blocked"
    | "changed-nothing"
    | "bad-reply"
    | "out-of-room",
    EndSpec
  >
> = {
  implemented: end(implemented),
  "wiki-only": end(() => ({ kind: "saved", stage: "review" })),
  blocked: end((data: ImplData) =>
    stopped(data, NOT_DOABLE, {
      reason: "the implementer could not do the issue as written",
      detail: summaryOf(data),
    }),
  ),
  "changed-nothing": end((data: ImplData) =>
    stopped(data, NOT_DOABLE, {
      reason: "the implementer changed nothing",
      detail: summaryOf(data),
    }),
  ),
  "bad-reply": end((data: ImplData) =>
    stopped(data, ERROR, {
      reason: "the implementer's reply could not be read",
      detail: "",
    }),
  ),
  "out-of-room": end(outOfRoom),
};

export { END_STATES };
