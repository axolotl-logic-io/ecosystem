// The sweep's driver. One sweep claims one issue and moves it as far as it
// can, through the stage groups in order (build, review and fix, sync and
// checks, then accept, security and merge), then closes the parents of split
// issues and releases the issue for the next sweep. The driver owns all of
// the sweep's state; its caller only awaits the launches it asks for:
//
//   let specs = sweep.next([]);
//   while (specs.length > 0) specs = sweep.next(await runs.all(specs));
//   return sweep.summary();
//
// `next` takes the raw results of the last batch, in its order, and returns
// the next batch, which is empty only once the sweep is finished. Every spec
// it returns counts against the per-run spawn cap.

import { parseOps } from "./launch-results.ts";
import type { LaunchSpec, OpsFrame } from "./launches.ts";
import { opsSpec } from "./launches.ts";
import {
  buildSummary,
  claimLaunch,
  claimStep,
  finishLaunches,
  sweepLaunch,
  sweepReplyOf,
} from "./stages/entry.ts";
import { parentsClosed } from "./stages/parents.ts";
import type { StageName, SweepSummary } from "./stages/types.ts";
import { sweepSettings } from "./sweep-config.ts";
import type { SweepCounts, SweepItem, SweepRun } from "./sweep-item.ts";
import {
  closingOf,
  hasRoom,
  opsLaunchSpec,
  stopIssue,
  summarySource,
} from "./sweep-item.ts";
import type { StageBatch, StagePhase } from "./sweep-stages.ts";
import { afterClaim, stageResults } from "./sweep-stages.ts";

// What the sweep awaits: the sweep op's reply, a candidate's claim, a stage
// group's batch, or the closing launches; or nothing, once it is finished.
type Phase =
  | { kind: "start" }
  | { kind: "sweep" }
  | { kind: "claim"; run: SweepRun; index: number }
  | { kind: "stages"; run: SweepRun; stages: StagePhase }
  | { kind: "finish"; run: SweepRun; parents: number }
  | { kind: "done"; run: SweepRun };

// The run's args as pi-subagents passes them: the repo config's path, the
// lane, and the one issue a human launched the run for, if any.
interface SweepArgs {
  config: string;
  lane?: unknown;
  issue?: unknown;
}

// The sweep's id and its clock.
interface SweepClock {
  sweepId: string;
  now: () => Date;
}

interface Sweep {
  next: (raw: readonly unknown[]) => LaunchSpec[];
  summary: () => SweepSummary;
}

interface Driver {
  frame: OpsFrame;
  now: () => Date;
  only: number | null;
  counts: SweepCounts;
  phase: Phase;
}

function laneOf(args: SweepArgs, sweepId: string): string {
  const { lane } = args;
  const named = Boolean(lane);
  if (named) {
    return String(lane);
  }
  return sweepId;
}

// The issue a human launched the run for, or null for every candidate.
function onlyOf(args: SweepArgs): number | null {
  const only = Number(args.issue);
  if (Number.isNaN(only) || only === 0) {
    return null;
  }
  return only;
}

// The sweep's run, once the sweep op has answered.
function runOf(driver: Driver, raw: unknown): SweepRun {
  const reply = sweepReplyOf(parseOps(raw));
  const settings = sweepSettings(reply.config);
  const run: SweepRun = {
    frame: driver.frame,
    counts: driver.counts,
    reply,
    settings,
    ctx: {
      cfg: reply.config,
      budgets: settings.budgets,
      models: settings.models,
      now: driver.now,
      hasRoom: (stage: StageName): boolean => hasRoom(run, stage),
    },
    abandoned: [],
    item: null,
    stopQueue: [],
    stagesRun: {},
    meta: {},
    parentsClosed: 0,
  };
  return run;
}

// The claim of the candidate at `index`, or, past the last, what follows.
function claimBatch(
  driver: Driver,
  run: SweepRun,
  index: number,
): LaunchSpec[] {
  const candidate = run.reply.items[index];
  if (candidate === undefined) {
    return stagesBatch(driver, run, afterClaim(run));
  }
  driver.phase = { kind: "claim", run, index };
  return [opsLaunchSpec(run, claimLaunch(candidate.number))];
}

// The issue the claim reply for candidate `n` gives the sweep, if any.
function claimedItem(run: SweepRun, n: number, raw: unknown): SweepItem | null {
  const step = claimStep(n, parseOps(raw));
  if (step.kind === "lost") {
    run.abandoned.push(step.abandoned);
    return null;
  }
  if (step.kind === "failed") {
    return { kind: "claim-failed", n, reason: step.reason };
  }
  const { st, paths, stop } = step;
  const item: SweepItem = {
    kind: "claimed",
    n,
    st,
    paths,
    closed: false,
    outcome: null,
    reason: null,
    held: false,
    rebasedOnly: false,
    outbox: { number: n, comments: [] },
  };
  run.item = item;
  if (stop !== null) {
    stopIssue(run, item, stop);
  }
  return item;
}

// Takes candidate `index`'s claim reply: after a lost claim the next
// candidate is claimed, and otherwise the sweep holds the issue.
function claimed(
  driver: Driver,
  run: SweepRun,
  index: number,
  raw: unknown,
): LaunchSpec[] {
  const n = run.reply.items[index]?.number ?? 0;
  const item = claimedItem(run, n, raw);
  if (item === null) {
    return claimBatch(driver, run, index + 1);
  }
  run.item = item;
  return stagesBatch(driver, run, afterClaim(run));
}

// A stage group's batch, or the closing launches once every group has ended.
function stagesBatch(
  driver: Driver,
  run: SweepRun,
  batch: StageBatch | null,
): LaunchSpec[] {
  if (batch === null) {
    return finishBatch(driver, run);
  }
  driver.phase = { kind: "stages", run, stages: batch.phase };
  return batch.specs;
}

// The parents to close, then the release of the open issue or the post of
// its last comments.
function finishBatch(driver: Driver, run: SweepRun): LaunchSpec[] {
  const launches = finishLaunches(run.reply.parents, closingOf(run.item));
  const parents = run.reply.parents.length;
  driver.phase = { kind: "finish", run, parents };
  if (launches.length === 0) {
    driver.phase = { kind: "done", run };
  }
  return launches.map((launch) => opsLaunchSpec(run, launch));
}

function advance(driver: Driver, raw: readonly unknown[]): LaunchSpec[] {
  const { phase } = driver;
  switch (phase.kind) {
    case "start": {
      driver.phase = { kind: "sweep" };
      const launch = sweepLaunch(driver.only);
      driver.counts.seq += 1;
      return [opsSpec(driver.frame, driver.counts.seq, launch, null)];
    }
    case "sweep":
      return claimBatch(driver, runOf(driver, raw[0]), 0);
    case "claim":
      return claimed(driver, phase.run, phase.index, raw[0]);
    case "stages":
      return stagesBatch(
        driver,
        phase.run,
        stageResults(phase.run, phase.stages, raw),
      );
    case "finish": {
      const replies = raw.slice(0, phase.parents).map(parseOps);
      phase.run.parentsClosed = parentsClosed(replies);
      driver.phase = { kind: "done", run: phase.run };
      return [];
    }
    case "done":
      return [];
    default:
      return unreachable(phase);
  }
}

function summaryOf(driver: Driver): SweepSummary {
  const { phase } = driver;
  if (phase.kind !== "done") {
    throw new Error(
      "sweep: the summary is ready only once the sweep is finished",
    );
  }
  const { run } = phase;
  return buildSummary({
    sweepId: run.frame.sweepId,
    lane: run.frame.lane,
    reply: run.reply,
    abandoned: run.abandoned,
    item: summarySource(run.item),
    parentsClosed: run.parentsClosed,
  });
}

function unreachable(value: never): never {
  throw new Error(`sweep: unexpected phase ${JSON.stringify(value)}`);
}

// Starts a sweep for the run's args, keyed by the clock's sweep id.
function startSweep(args: SweepArgs, clock: SweepClock): Sweep {
  const { sweepId, now } = clock;
  const lane = laneOf(args, sweepId);
  const driver: Driver = {
    frame: { config: args.config, sweepId, lane },
    now,
    only: onlyOf(args),
    counts: { seq: 0, spawned: 0 },
    phase: { kind: "start" },
  };
  return {
    next: (raw: readonly unknown[]): LaunchSpec[] => {
      const specs = advance(driver, raw);
      driver.counts.spawned += specs.length;
      return specs;
    },
    summary: (): SweepSummary => summaryOf(driver),
  };
}

export type { Sweep, SweepArgs, SweepClock };
export { startSweep };
