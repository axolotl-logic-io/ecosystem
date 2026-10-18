// The implementor's end states (the wiki's Pipeline-Roles-Implementor,
// "Lifecycle" and "Entry `checks`"): how each finished run ends, and the stop each failure
// posts through the `stop` op. An end state routes nowhere, so it answers
// no result. Pure.

import { outOfRoomReason } from "../../workflow/stages/continuation.ts";
import type { End, StateSpec } from "../machine.ts";
import type { ChecksEnd } from "./checks-data.ts";
import type { ImplData, ImplState } from "./locate.ts";
import { IMPL_ROLE } from "./locate.ts";

type EndSpec = StateSpec<ImplState, never, ImplData>;

// The stop codes (src/stops.ts): agent:stopped-too-large,
// agent:stopped-not-doable, agent:stopped-error, and the checks entry's
// agent:stopped-check-fixes, agent:stopped-checks-unrelated,
// agent:stopped-branch-changed and agent:stopped-no-ci.
const TOO_LARGE = "too-large";
const NOT_DOABLE = "not-doable";
const ERROR = "error";
const CHECK_FIXES = "check-fixes";
const CHECKS_UNRELATED = "checks-unrelated";
const BRANCH_CHANGED = "branch-changed";
const NO_CI = "no-ci";

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

// A stop with no detail beyond its reason.
function plainStop(code: string, reason: string): EndSpec {
  return end((data: ImplData) => stopped(data, code, { reason, detail: "" }));
}

function fixSummaryOf(data: ImplData): string {
  return data.fix?.summary ?? "";
}

// A CI fixer's handoff with no continuation left: the fix is too large.
function fixOutOfRoom(data: ImplData): End {
  return stopped(data, TOO_LARGE, {
    reason: outOfRoomReason("CI fixer", data.maxContinuations),
    detail: `Latest handoff: ${data.settings.paths.handoffFile}\n\n${fixSummaryOf(data)}`,
  });
}

// Saved at merge after a tests-only rerun of an accepted head, else at
// accept.
function checked(data: ImplData): Extract<End, { kind: "saved" }> {
  if (data.rebasedOnly) {
    return { kind: "saved", stage: "merge" };
  }
  return { kind: "saved", stage: "accept" };
}

const CHECKS_END_STATES: Readonly<Record<ChecksEnd, EndSpec>> = {
  checked: end(checked),
  "ci-pending": end(() => ({ kind: "held" })),
  "fix-limit": end((data: ImplData) =>
    stopped(data, CHECK_FIXES, {
      reason: `checks still fail after ${data.maxCiFixes} CI-fix attempts`,
      detail: data.failure ?? "",
    }),
  ),
  "fix-out-of-room": end(fixOutOfRoom),
  "checks-unrelated": end((data: ImplData) =>
    stopped(data, CHECKS_UNRELATED, {
      reason: "the check fixer can't fix the failing checks from the repo",
      detail: fixSummaryOf(data),
    }),
  ),
  "bad-fix-reply": plainStop(ERROR, "the CI fixer's reply could not be read"),
  "bad-review": plainStop(ERROR, "a check-fix reviewer failed"),
  "verify-moved": plainStop(
    BRANCH_CHANGED,
    "the branch changed during verification",
  ),
  "ci-moved": plainStop(
    BRANCH_CHANGED,
    "the branch changed outside the pipeline while CI ran",
  ),
  "no-ci": plainStop(
    NO_CI,
    "the PR has no required CI checks, and this repo's config requires them",
  ),
};

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
    | "out-of-room"
    | ChecksEnd,
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
  ...CHECKS_END_STATES,
};

export type { EndSpec };
export { END_STATES, end, stopped };
