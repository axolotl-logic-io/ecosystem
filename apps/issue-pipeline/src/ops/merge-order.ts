// The merge order between issues: which other issue's PR should merge before
// this one's. The orchestrator passes its ranked queue (#234), whose issues
// at review or merge hold the merge slot whatever their verdict, since a
// stale approval is never authorization; without a queue and with mergeOrder
// set, the oldest PR at the merge stage goes first (decision merge-order).

import { z } from "zod";
import type { Config } from "../config.ts";
import { ghJson } from "../github.ts";
import { LABELS } from "../labels.ts";
import { readState } from "../saved-state.ts";
import { isStopLabel } from "../stops.ts";

const MS_PER_HOUR = 3_600_000;
const WORKING_LIST_LIMIT = "100";

// The stages where an issue ranks for merge: the orchestrator reserves the
// merge slot for it from review through the merge.
const READY_STAGES: ReadonlySet<string> = new Set(["review", "merge"]);

// The ready stages whose issues hold the merges ranked after them in the
// orchestrator's queue (#358).
const HOLDING_STAGES: ReadonlySet<string> = READY_STAGES;

// Without a queue, only an older PR already at the merge stage, minutes from
// merging, holds a merge.
const DEFAULT_HOLDING_STAGES: ReadonlySet<string> = new Set(["merge"]);

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

interface Ahead {
  number: number;
  pr: number;
}

// The PR of issue #number when it should merge before PR `pr`: at the merge
// stage, with an older PR and a lease that hasn't expired (a crashed sweep).
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
  if (data.pr >= pr || !DEFAULT_HOLDING_STAGES.has(data.stage)) {
    return undefined;
  }
  const at = data.lease?.at;
  const leased = at !== undefined && at !== null && at !== "";
  if (leased && Date.now() - Date.parse(at) >= leaseMs) {
    return undefined;
  }
  return data.pr;
}

// The open issue, other than #n, that should merge before PR `pr`: one at the
// merge stage whose PR is older. Without this, a slow issue's long verify
// keeps losing the merge to quick issues in the other slots.
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
// open, not stopped and at a holding stage.
function aheadInQueue(
  cfg: Config,
  n: number,
  queue: readonly number[],
): Ahead | null {
  const at = queue.indexOf(n);
  for (const number of queue.slice(0, Math.max(at, 0))) {
    if (openUnstopped(cfg, number)) {
      const ready = READY_STATE.safeParse(readState(cfg, number).state);
      if (ready.success && HOLDING_STAGES.has(ready.data.stage)) {
        return { number, pr: ready.data.pr };
      }
    }
  }
  return null;
}

// Why issue #number's merge waits for another issue, or undefined when it
// need not wait. A queue is always enforced; the default order only with
// mergeOrder set.
function queued(cfg: Config, req: OrderRequest): Queued | undefined {
  let ahead: Ahead | null;
  if (req.mergeQueue !== undefined && req.mergeQueue !== null) {
    ahead = aheadInQueue(cfg, req.number, req.mergeQueue);
  } else if (req.mergeOrder === true) {
    ahead = olderReadyIssue(cfg, req.number, req.state.pr);
  } else {
    return undefined;
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

export type { Queued };
export { HOLDING_STAGES, queued, READY_STAGES };
