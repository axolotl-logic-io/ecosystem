// @ts-check
// The orchestrator's scheduler for stacked branches (#290), on recorded
// queue snapshots: a dependent starts on its prerequisite's branch once that
// one reaches checks with no open findings, one level deep; a stacked
// dependent waits at merge while its prerequisite is open, syncs when it
// moves or merges, and is held while it is stopped or closed unmerged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRank } from "../src/orchestrator/queue.ts";
import { schedule } from "../src/orchestrator/schedule.ts";
import { MERGE_OVER_CHAIN, NOW, SETTINGS } from "./orchestrator-fixtures.mjs";
import {
  DEPENDENT,
  MOVED_HEAD,
  OLDER_DEPENDENT_AT_REVIEW,
  OTHER,
  OTHER_AT_MERGE,
  openPrereq,
  overlapping,
  PREREQ,
  stackedAt,
  waitingOn,
} from "./orchestrator-stacked-fixtures.mjs";

/** @import { Prereq, Snapshot } from "../src/orchestrator/queue.ts" */

// Each decision as `#issue stage action reason`, with the prerequisite a
// start stacks on, in the order made.
/** @param {Snapshot} snapshot @returns {string[]} */
function decided(snapshot) {
  return schedule(snapshot, SETTINGS, NOW).map((decision) => {
    const { issue, stage, action, reason } = decision;
    let stack = "";
    if (decision.action === "started" && decision.stackOn !== null) {
      stack = ` stack-on:#${decision.stackOn}`;
    }
    return `#${issue} ${stage} ${action} ${reason}${stack}`;
  });
}

// The dependent's decision alone.
/** @param {Snapshot} snapshot @returns {string | undefined} */
function dependentDecision(snapshot) {
  return decided(snapshot).find((line) => line.startsWith(`#${DEPENDENT} `));
}

const HELD_AFTER = `#${DEPENDENT} triage held after:#${PREREQ}`;

test("a waiting issue is held until its prerequisite reaches checks with no open findings", () => {
  assert.equal(
    dependentDecision(waitingOn(openPrereq({ stage: "review" }))),
    HELD_AFTER,
  );
  assert.equal(
    dependentDecision(waitingOn(openPrereq({ openFindings: 1 }))),
    HELD_AFTER,
  );
});

test("a waiting issue starts on its prerequisite's branch once that one is at checks or later", () => {
  const started = `#${DEPENDENT} triage started free stack-on:#${PREREQ}`;
  assert.equal(dependentDecision(waitingOn(openPrereq())), started);
  assert.equal(
    dependentDecision(waitingOn(openPrereq({ stage: "merge" }))),
    started,
  );
  const atSpec = waitingOn(openPrereq(), { stage: "spec" });
  assert.equal(
    dependentDecision(atSpec),
    `#${DEPENDENT} spec started free stack-on:#${PREREQ}`,
  );
});

test("a second-level stack is refused: a prerequisite stacked itself holds its dependent", () => {
  const [decision] = schedule(
    waitingOn(openPrereq({ stacked: true })),
    SETTINGS,
    NOW,
  );
  assert.deepEqual(decision, {
    action: "held",
    at: NOW.toISOString(),
    issue: DEPENDENT,
    stage: "triage",
    reason: `after:#${PREREQ}`,
  });
});

test("a stacked issue is held at merge while its prerequisite is open, and isn't in the merge queue", () => {
  const snapshot = stackedAt("merge", openPrereq({ stage: "review" }), [
    OTHER_AT_MERGE,
  ]);
  assert.deepEqual(mergeRank(snapshot.issues), [OTHER]);
  assert.deepEqual(decided(snapshot), [
    `#${DEPENDENT} merge held stacked-on:#${PREREQ}`,
    `#${OTHER} merge started merge-first`,
  ]);
});

test("a stacked issue syncs when its prerequisite's head moved, and otherwise runs its stage", () => {
  const moved = openPrereq({ stage: "fix", headSha: MOVED_HEAD });
  assert.equal(
    dependentDecision(stackedAt("accept", moved)),
    `#${DEPENDENT} sync started free`,
  );
  assert.equal(
    dependentDecision(stackedAt("accept", openPrereq({ stage: "fix" }))),
    `#${DEPENDENT} accept started free`,
  );
});

test("a stacked issue at merge syncs once its prerequisite merged, and ranks for merge again", () => {
  /** @type {Prereq} */
  const prereq = { number: PREREQ, status: "merged" };
  const merged = stackedAt("merge", prereq);
  assert.deepEqual(decided(merged), [`#${DEPENDENT} sync started free`]);
  assert.deepEqual(mergeRank(merged.issues), [DEPENDENT]);
});

test("a stopped prerequisite holds its waiting and its stacked dependent", () => {
  const stopped = `#${DEPENDENT} triage held after:#${PREREQ}:stopped`;
  for (const prereq of [
    openPrereq({ stopped: true }),
    openPrereq({ stage: "stopped", stopped: true }),
  ]) {
    assert.equal(dependentDecision(waitingOn(prereq)), stopped);
    assert.equal(
      dependentDecision(stackedAt("fix", prereq)),
      `#${DEPENDENT} fix held after:#${PREREQ}:stopped`,
    );
  }
});

test("a prerequisite closed unmerged holds its stacked dependent", () => {
  /** @type {Prereq} */
  const closed = { number: PREREQ, status: "closed-unmerged" };
  assert.deepEqual(decided(stackedAt("merge", closed)), [
    `#${DEPENDENT} merge held after:#${PREREQ}:closed-unmerged`,
  ]);
});

test("a stacked issue's implement and fix aren't held by its prerequisite's overlapping files", () => {
  assert.deepEqual(decided(overlapping("implement")), [
    `#${PREREQ} fix started free`,
    `#${DEPENDENT} implement started free`,
  ]);
  assert.deepEqual(decided(overlapping("fix")), [
    `#${PREREQ} fix started free`,
    `#${DEPENDENT} fix started free`,
  ]);
});

test("a prerequisite's checks aren't held by an older dependent stacked on it", () => {
  assert.deepEqual(decided(OLDER_DEPENDENT_AT_REVIEW), [
    `#${PREREQ} checks started free`,
  ]);
});

test("with no after mark and no stack, the decisions are as before and none stacks", () => {
  assert.deepEqual(decided(MERGE_OVER_CHAIN), [
    "#83 merge held merge-order:#85",
    "#85 sync started free",
    "#84 fix held files-overlap:#83",
    "#86 spec started free",
  ]);
  const stacks = schedule(MERGE_OVER_CHAIN, SETTINGS, NOW).flatMap(
    (decision) => {
      if (decision.action === "started") {
        return [decision.stackOn];
      }
      return [];
    },
  );
  assert.deepEqual(stacks, [null, null]);
});
