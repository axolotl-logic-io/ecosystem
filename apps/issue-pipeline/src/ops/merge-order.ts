// The merge order between issues: which other issue's PR should merge before
// this one's. A stacked issue always waits for its open prerequisite (#289).
// Otherwise, by default the oldest ready PR goes first (decision
// merge-order); the orchestrator can pass its own ranked queue instead (#234).

import { z } from "zod";
import type { Config } from "../config.ts";
import { ghJson } from "../github.ts";
import { LABELS } from "../labels.ts";
import type { StackedOn } from "../stack.ts";
import { prereqMerged } from "../stack.ts";
import { readState } from "../state.ts";
import { isStopLabel } from "../stops.ts";
import { openPrFor } from "./prs.ts";

const MS_PER_HOUR = 3_600_000;
const WORKING_LIST_LIMIT = "100";

// Stages after review, where an issue only waits to merge.
const READY_STAGES: ReadonlySet<string> = new Set([
  "sync",
  "checks",
  "accept",
  "security",
  "merge",
]);

// The issues gh lists, and the part of another issue's state the order reads.
const WORKING = z
  .array(
    z.looseObject({
      labels: z.array(z.looseObject({ name: z.string() })),
      number: z.number(),
    }),
  )
  .nullable();
// One issue as gh shows it.
const VIEWED = z
  .looseObject({
    labels: z.array(z.looseObject({ name: z.string() })),
    state: z.string(),
  })
  .nullable();
const READY_STATE = z.looseObject({
  lease: z.looseObject({ at: z.string().nullish() }).nullish(),
  pr: z.number().positive(),
  stage: z.string(),
});

// What the order reads from a merge request.
interface OrderRequest {
  number: number;
  mergeOrder?: boolean | null | undefined;
  mergeQueue?: readonly number[] | null | undefined;
  state: { pr: number };
}

// The merge waits for issue #waitingFor and its PR #waitingForPr.
interface Queued {
  merged: false;
  reason: "queued";
  waitingFor: number;
  waitingForPr: number;
}

// The merge waits for prerequisite #stackedOn, the issue it is stacked on.
interface StackQueued extends Queued {
  stackedOn: number;
}

interface Ahead {
  number: number;
  pr: number;
}

// The PR of issue #number when it should merge before PR `pr`: past review,
// with an older PR and a lease that hasn't expired (a crashed sweep).
function readyPr(
  cfg: Config,
  number: number,
  pr: number,
  leaseMs: number,
): number | undefined {
  const parsed = READY_STATE.safeParse(readState(cfg, number).state);
  if (!parsed.success) {
    return undefined;
  }
  const { data } = parsed;
  if (data.pr >= pr || !READY_STAGES.has(data.stage)) {
    return undefined;
  }
  const at = data.lease?.at;
  const leased = at !== undefined && at !== null && at !== "";
  if (leased && Date.now() - Date.parse(at) >= leaseMs) {
    return undefined;
  }
  return data.pr;
}

// The open issue, other than #n, that should merge before PR `pr`: one past
// review whose PR is older. Without this, a slow issue's long verify keeps
// losing the merge to quick issues in the other slots.
function olderReadyIssue(cfg: Config, n: number, pr: number): Ahead | null {
  const listed = ghJson(cfg, [
    "issue",
    "list",
    "-R",
    cfg.repo,
    "--state",
    "open",
    "--label",
    LABELS.working.name,
    "--limit",
    WORKING_LIST_LIMIT,
    "--json",
    "number,labels",
  ]);
  const leaseMs = cfg.leaseHours * MS_PER_HOUR;
  let best: Ahead | null = null;
  for (const issue of WORKING.parse(listed) ?? []) {
    const stopped = issue.labels.some((label) => isStopLabel(label.name));
    if (issue.number !== n && !stopped) {
      const older = readyPr(cfg, issue.number, pr, leaseMs);
      if (older !== undefined && (best === null || older < best.pr)) {
        best = { number: issue.number, pr: older };
      }
    }
  }
  return best;
}

// Whether issue #n is open and carries no stop label. Read one issue at a
// time, so no list limit can leave it out.
function openUnstopped(cfg: Config, n: number): boolean {
  const viewed = VIEWED.parse(
    ghJson(cfg, [
      "issue",
      "view",
      String(n),
      "-R",
      cfg.repo,
      "--json",
      "state,labels",
    ]),
  );
  return (
    viewed !== null &&
    viewed.state === "OPEN" &&
    !viewed.labels.some((label) => isStopLabel(label.name))
  );
}

// The first issue ahead of #n in the orchestrator's ranked queue that is
// open, not stopped and at a ready stage.
function aheadInQueue(
  cfg: Config,
  n: number,
  queue: readonly number[],
): Ahead | null {
  const at = queue.indexOf(n);
  for (const number of queue.slice(0, Math.max(at, 0))) {
    if (openUnstopped(cfg, number)) {
      const ready = READY_STATE.safeParse(readState(cfg, number).state);
      if (ready.success && READY_STAGES.has(ready.data.stage)) {
        return { number, pr: ready.data.pr };
      }
    }
  }
  return null;
}

// Why issue #number's merge waits for another issue, or undefined when it
// need not wait.
function queued(cfg: Config, req: OrderRequest): Queued | undefined {
  if (req.mergeOrder !== true) {
    return undefined;
  }
  let ahead: Ahead | null;
  if (req.mergeQueue === undefined || req.mergeQueue === null) {
    ahead = olderReadyIssue(cfg, req.number, req.state.pr);
  } else {
    ahead = aheadInQueue(cfg, req.number, req.mergeQueue);
  }
  if (ahead === null) {
    return undefined;
  }
  return {
    merged: false,
    reason: "queued",
    waitingFor: ahead.number,
    waitingForPr: ahead.pr,
  };
}

// Why a merge stacked on `stackedOn` waits for its prerequisite, or undefined
// once the prerequisite has merged. A stacked issue's merge waits while its
// prerequisite is open, whatever the merge order. `waitingForPr` is the
// prerequisite's open PR, or 0 when it has none.
function stackedQueued(
  cfg: Config,
  stackedOn: StackedOn,
): StackQueued | undefined {
  const { issue } = stackedOn;
  if (prereqMerged(cfg, issue)) {
    return undefined;
  }
  return {
    merged: false,
    reason: "queued",
    waitingFor: issue,
    waitingForPr: openPrFor(cfg, issue) ?? 0,
    stackedOn: issue,
  };
}

export type { Queued, StackQueued };
export { queued, READY_STAGES, stackedQueued };
