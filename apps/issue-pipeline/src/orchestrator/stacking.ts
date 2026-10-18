// The scheduler's stacking rules (#268, #290): when an issue that waits on a
// prerequisite starts on that prerequisite's branch, what holds a stacked
// issue while its prerequisite is open, stopped or closed, when a stacked
// issue goes back to sync onto its prerequisite's new head or the base, and
// which pairs of issues the file-overlap gate leaves alone. Pure.

import type { Prereq, SnapshotIssue, StackedOn } from "./queue.ts";
import { runStage, stageIndex } from "./queue.ts";

// What the stacking rules make of an issue: nothing (the usual rules apply),
// a hold, or a run of `stage`, stacked on issue `stackOn` when it isn't null.
type StackRule =
  | { kind: "none" }
  | { kind: "hold"; reason: string }
  | { kind: "run"; stage: string; stackOn: number | null };

type OpenPrereq = Prereq & { status: "open" };

const NONE: StackRule = { kind: "none" };
// The stages a waiting issue may start stacked on its prerequisite.
const STACK_STARTS: ReadonlySet<string> = new Set([
  "triage",
  "spec",
  "implement",
]);
// A prerequisite this far along, with no open findings, can be stacked on.
const STACKABLE_FROM = stageIndex("checks");
// A stacked issue at these stages goes back to sync when its prerequisite's
// head moves or it merges.
const SYNC_AT = stageIndex("sync");
const MERGE_AT = stageIndex("merge");

function hold(reason: string): StackRule {
  return { kind: "hold", reason };
}

// The issue it waits on when it can't start stacked on it.
function afterHold(prereq: Prereq): StackRule {
  return hold(`after:#${prereq.number}`);
}

// True when a waiting issue may start stacked on open prerequisite `prereq`.
function stackable(prereq: OpenPrereq): boolean {
  return (
    !prereq.stacked &&
    stageIndex(prereq.stage) >= STACKABLE_FROM &&
    prereq.openFindings === 0
  );
}

// An issue that isn't stacked and waits on its after mark: it starts stacked
// on its prerequisite once that one is far enough along, and only one level
// deep, and not while that one's branch lacks the merge commit of another
// merged prerequisite (#328). The usual verdict hold applies when it has no
// prerequisite.
function waitingRule(issue: SnapshotIssue): StackRule {
  const { prereq } = issue;
  const stage = runStage(issue);
  if (prereq === null || !STACK_STARTS.has(stage)) {
    return NONE;
  }
  switch (prereq.status) {
    case "open":
      if (prereq.stopped) {
        return hold(`after:#${prereq.number}:stopped`);
      }
      if (stackable(prereq)) {
        if (prereq.behind) {
          return hold(`stacked-on-behind:#${prereq.number}`);
        }
        return { kind: "run", stage, stackOn: prereq.number };
      }
      return afterHold(prereq);
    case "merged":
    case "closed-unmerged":
      return afterHold(prereq);
    default: {
      const unknown: never = prereq;
      throw new Error(`unknown prerequisite ${JSON.stringify(unknown)}`);
    }
  }
}

// True when a stacked issue at `stage` must sync before going on: its
// prerequisite merged, or that one's head moved since the issue was put on it.
function needsRestack(
  stage: string,
  prereq: Prereq,
  stackedOn: StackedOn,
): boolean {
  const at = stageIndex(stage);
  if (at < SYNC_AT || at > MERGE_AT) {
    return false;
  }
  switch (prereq.status) {
    case "merged":
      return true;
    case "open":
      return prereq.headSha !== null && prereq.headSha !== stackedOn.headSha;
    case "closed-unmerged":
      return false;
    default: {
      const unknown: never = prereq;
      throw new Error(`unknown prerequisite ${JSON.stringify(unknown)}`);
    }
  }
}

// A stacked issue: held while its prerequisite is stopped or closed unmerged,
// and at merge while it is open; synced when it moved or merged; otherwise
// run as usual, unless its after mark names another open issue.
function stackedRule(issue: SnapshotIssue, stackedOn: StackedOn): StackRule {
  const { prereq } = issue;
  if (prereq === null) {
    return NONE;
  }
  const { number, status } = prereq;
  if (status === "closed-unmerged") {
    return hold(`after:#${number}:closed-unmerged`);
  }
  if (prereq.status === "open" && prereq.stopped) {
    return hold(`after:#${number}:stopped`);
  }
  const stage = runStage(issue);
  if (needsRestack(stage, prereq, stackedOn)) {
    return { kind: "run", stage: "sync", stackOn: null };
  }
  if (stage === "merge" && status === "open") {
    return hold(`stacked-on:#${number}`);
  }
  const other = issue.after.find((n) => n !== number);
  if (other !== undefined) {
    return hold(`after:#${other}`);
  }
  return { kind: "run", stage, stackOn: null };
}

// What the stacking rules make of a candidate or waiting issue.
function stackRule(issue: SnapshotIssue): StackRule {
  const { verdict, stackedOn } = issue;
  if (verdict.kind !== "candidate" && verdict.kind !== "waiting-on-after") {
    return NONE;
  }
  if (stackedOn !== null) {
    return stackedRule(issue, stackedOn);
  }
  if (verdict.kind === "waiting-on-after") {
    return waitingRule(issue);
  }
  return NONE;
}

function partnerOf(issue: SnapshotIssue, other: SnapshotIssue): boolean {
  return (
    issue.stackedOn?.issue === other.number ||
    issue.prereq?.number === other.number
  );
}

// True when one of the two is the other's prerequisite: their files may
// overlap, since the dependent builds on the prerequisite's branch.
function stackPartners(a: SnapshotIssue, b: SnapshotIssue): boolean {
  return partnerOf(a, b) || partnerOf(b, a);
}

export type { StackRule };
export { stackable, stackPartners, stackRule };
