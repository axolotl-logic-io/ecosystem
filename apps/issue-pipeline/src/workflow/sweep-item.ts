// The sweep's run and the issue it holds: what a sweep knows once the sweep op
// has answered, and how a stage's step changes the issue. Every launch takes
// the next sequence number when its spec is built, so a stop queued now keeps
// its place in the keys even though it is posted at the end of its group.

import { clip } from "./clip.ts";
import { noteEvent } from "./event-log.ts";
import type { LaunchSpec, OpsFrame, OpsSpec, Outbox } from "./launches.ts";
import { childSpec, opsSpec } from "./launches.ts";
import type { LaunchMeta } from "./signing.ts";
import type { ClosingItem, SummarySource } from "./stages/entry.ts";
import type {
  AbandonedClaim,
  Launch,
  OpLaunch,
  StageComment,
  StageContext,
  StageName,
  StageState,
  StageStop,
  Step,
  SweepReply,
} from "./stages/types.ts";
import type { SweepSettings } from "./sweep-config.ts";
import { STAGE_SPAWNS } from "./sweep-config.ts";
import type { IssueState, ItemPaths } from "./types.ts";

const COMMENT_LIMIT = 60_000;
const STOP_DETAIL_LIMIT = 3000;
// The spawns kept for the issue: its release or stop op, and a final post.
const ITEM_RESERVE = 3;

// The issue the sweep claimed. `closed` ends its work for this sweep.
interface ClaimedItem {
  kind: "claimed";
  n: number;
  st: IssueState;
  paths: ItemPaths;
  closed: boolean;
  outcome: string | null;
  reason: string | null;
  held: boolean;
  rebasedOnly: boolean;
  outbox: Outbox;
}

// A candidate whose claim failed: the sweep does nothing more with it.
interface FailedItem {
  kind: "claim-failed";
  n: number;
  reason: string | null;
}

type SweepItem = ClaimedItem | FailedItem;

// How many launches have taken a key, and how many the sweep has spawned.
interface SweepCounts {
  seq: number;
  spawned: number;
}

interface SweepRun {
  frame: OpsFrame;
  counts: SweepCounts;
  reply: SweepReply;
  settings: SweepSettings;
  ctx: StageContext;
  abandoned: AbandonedClaim[];
  item: SweepItem | null;
  // The stops built but not yet posted, in the order they were queued.
  stopQueue: OpsSpec[];
  // How many times each stage has begun this sweep.
  stagesRun: Partial<Record<StageName, number>>;
  // The last stage this run may begin (args.through), or null for every stage.
  through: StageName | null;
  // The agent and model of each session launched, by key.
  meta: Record<string, LaunchMeta>;
  parentsClosed: number;
}

// The ops spec for `launch`. The queued comments of the claimed issue ride
// along when the launch names it.
function opsLaunchSpec(run: SweepRun, launch: OpLaunch): OpsSpec {
  run.counts.seq += 1;
  let outbox: Outbox | null = null;
  if (run.item?.kind === "claimed") {
    ({ outbox } = run.item);
  }
  return opsSpec(run.frame, run.counts.seq, launch, outbox);
}

// The spec for a stage's launch, its key prefixed with the issue's number.
function stageLaunchSpec(
  run: SweepRun,
  item: ClaimedItem,
  launch: Launch,
): LaunchSpec {
  if (launch.kind === "op") {
    return opsLaunchSpec(run, { ...launch, name: `i${item.n}-${launch.name}` });
  }
  run.counts.seq += 1;
  const where = { n: item.n, worktree: item.paths.worktree };
  return childSpec(run.counts.seq, where, launch, run.meta);
}

function logEvent(run: SweepRun, item: ClaimedItem, text: string): void {
  noteEvent(item.st, text, run.ctx.now());
}

// Queues a signed comment for the issue, or for its PR once it has one.
function say(item: ClaimedItem, comment: StageComment): void {
  const { pr } = item.st;
  let number = item.n;
  if (comment.where === "pr" && typeof pr === "number" && pr !== 0) {
    number = pr;
  }
  const body = clip(comment.body, COMMENT_LIMIT);
  item.outbox.comments.push({ number, by: comment.by, body });
}

// Stops work on an open issue and queues the stop op, which carries the
// comments queued so far.
function stopIssue(run: SweepRun, item: ClaimedItem, stop: StageStop): void {
  if (item.closed) {
    return;
  }
  item.closed = true;
  item.outcome = "stopped";
  item.reason = stop.reason;
  logEvent(run, item, `stopped: ${stop.reason}`);
  const payload = {
    number: item.n,
    state: item.st,
    reason: stop.reason,
    detail: clip(stop.detail ?? "", STOP_DETAIL_LIMIT),
    nextStep: null,
    code: stop.code,
  };
  const name = `i${item.n}-stop`;
  run.stopQueue.push(
    opsLaunchSpec(run, { kind: "op", name, op: "stop", payload }),
  );
}

// The issue as its stage sees it, with what the stage carries to its next step.
function stageState(
  item: ClaimedItem,
  phase: string,
  carry: unknown,
): StageState {
  const { n, paths, st, closed, outcome, held, rebasedOnly } = item;
  return { n, paths, st, closed, outcome, held, rebasedOnly, phase, carry };
}

// Applies a step to the issue: its state, then its comments, then its stop,
// so a comment rides on the next ops request. A done step with `again` lets
// the issue's stage begin again. Returns the specs of its launches.
function applyStep(run: SweepRun, item: ClaimedItem, step: Step): LaunchSpec[] {
  const { state } = step;
  item.st = state.st;
  item.closed = state.closed;
  item.outcome = state.outcome;
  item.held = state.held;
  item.rebasedOnly = state.rebasedOnly;
  for (const comment of step.comments) {
    say(item, comment);
  }
  if (step.stop !== null) {
    stopIssue(run, item, step.stop);
  }
  if (step.done) {
    if (step.again) {
      run.stagesRun = withoutStage(run.stagesRun, item.st.stage);
    }
    return [];
  }
  return step.launches.map((launch) => stageLaunchSpec(run, item, launch));
}

function withoutStage(
  stagesRun: Partial<Record<StageName, number>>,
  stage: string,
): Partial<Record<StageName, number>> {
  return Object.fromEntries(
    Object.entries(stagesRun).filter(([name]) => name !== stage),
  );
}

// Whether `stage` fits under the spawn cap, keeping room for the release or
// stop op and a final comment post, plus closing the parents.
function hasRoom(run: SweepRun, stage: StageName): boolean {
  let reserve = run.reply.parents.length + 1;
  if (run.item !== null) {
    reserve += ITEM_RESERVE;
  }
  const { spawned } = run.counts;
  return spawned + STAGE_SPAWNS[stage] + reserve <= run.settings.spawnLimit;
}

// Whether `stage` fits. If not, the issue is held at it until next sweep.
function fits(run: SweepRun, item: ClaimedItem, stage: StageName): boolean {
  if (hasRoom(run, stage)) {
    return true;
  }
  if (!item.held) {
    item.held = true;
    logEvent(
      run,
      item,
      `held at ${stage} by the per-run spawn cap; continues next sweep`,
    );
  }
  return false;
}

// The issue as the sweep closes it.
function closingOf(item: SweepItem | null): ClosingItem | null {
  if (item?.kind !== "claimed") {
    return null;
  }
  const { n, st, closed, outbox } = item;
  let openState: IssueState | null = null;
  if (!closed) {
    openState = st;
  }
  return { n, openState, queued: outbox.comments.length };
}

// The issue as the summary reports it.
function summarySource(item: SweepItem | null): SummarySource | null {
  if (item === null) {
    return null;
  }
  if (item.kind === "claim-failed") {
    return {
      n: item.n,
      st: null,
      outcome: "claim-failed",
      reason: item.reason,
    };
  }
  const { n, st, outcome, reason } = item;
  return { n, st, outcome, reason };
}

export type { ClaimedItem, FailedItem, SweepCounts, SweepItem, SweepRun };
export {
  applyStep,
  closingOf,
  fits,
  hasRoom,
  opsLaunchSpec,
  stageState,
  stopIssue,
  summarySource,
};
