// The `fix` entry's end states (#418; the wiki's Pipeline-Roles-Implementor,
// "Entry `fix`"): once every finding is resolved, saved at checks and
// carried on there in the same job (`next(checks)`, #424,
// `implementor-one-job`); saved at open-pr to reopen a closed PR; and the
// stops today's fix and rereview stages give. Pure.

import {
  findingsStopCode,
  findingsStopReason,
  findingsText,
} from "../../workflow/findings.ts";
import { outOfRoomReason } from "../../workflow/stages/continuation.ts";
import type { Finding } from "../../workflow/types.ts";
import type { End } from "../machine.ts";
import type { EndSpec } from "./ends.ts";
import { end, stopped } from "./ends.ts";
import type { FixStop } from "./fix-data.ts";
import { findingsOf } from "./fix-data.ts";
import { FIXER_ROLE, openOf } from "./fix-task.ts";
import { acceptanceStop } from "./fix-update.ts";
import type { ImplData } from "./locate.ts";

// The stop codes (src/stops.ts).
const ERROR = "error";
const REVIEW_ROUNDS = "review-rounds";

type FixEnd =
  | "fixed"
  | "fix-reopen"
  | "fix-no-code"
  | "findings-open"
  | "acceptance-disputed"
  | "reintroduced"
  | "rereview-bad"
  | "fixer-bad-reply"
  | "fixer-out-of-room";

function item(data: ImplData): { st: { findings: Finding[] } } {
  return { st: { findings: findingsOf(data.findings) } };
}

// Open findings after the last round: an open security finding's category
// and reason, the acceptance check's, or the generic one.
function findingsOpen(data: ImplData): End {
  const { maxFixRounds } = data;
  const base = `blocking findings remain after ${maxFixRounds} fix rounds`;
  const open = item(data);
  return stopped(data, findingsStopCode(open) ?? REVIEW_ROUNDS, {
    reason: findingsStopReason({ maxFixRounds }, open, base),
    detail: findingsText(openOf(data)),
  });
}

// The stop update-findings found, under `code`.
function foundStop(code: string): (data: ImplData) => End {
  return (data: ImplData): End => {
    const stop: FixStop = data.fixStop ?? { reason: "", detail: "" };
    return stopped(data, code, stop);
  };
}

function outOfRoom(data: ImplData): End {
  return stopped(data, "too-large", {
    reason: outOfRoomReason(FIXER_ROLE, data.maxContinuations),
    detail: `Latest handoff: ${data.settings.paths.handoffFile}\n\n${data.fixReply?.summary ?? ""}`,
  });
}

const FIX_END_STATES: Readonly<Record<FixEnd, EndSpec>> = {
  fixed: end(() => ({ kind: "next", stage: "checks" })),
  "fix-reopen": end(() => ({ kind: "saved", stage: "open-pr" })),
  "fix-no-code": end((data: ImplData) =>
    stopped(data, "not-doable", {
      reason: "the fix left the branch with no code change",
      detail: "",
    }),
  ),
  "findings-open": end(findingsOpen),
  "acceptance-disputed": end((data: ImplData) => {
    const { reason, detail } = acceptanceStop(data);
    return stopped(data, "acceptance", { reason, detail });
  }),
  reintroduced: end(foundStop("fix-loop")),
  "rereview-bad": end(foundStop(ERROR)),
  "fixer-bad-reply": end((data: ImplData) =>
    stopped(data, ERROR, {
      reason: "the fixer's reply could not be read",
      detail: "",
    }),
  ),
  "fixer-out-of-room": end(outOfRoom),
};

export type { FixEnd };
export { FIX_END_STATES };
