// @ts-check
// The orchestrator's scheduler (#234) on recorded queue snapshots: readers
// run in parallel up to the caps, writers wait on overlapping files, merges
// go in the order of what they unblock, and the rate limit holds every start.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRank } from "../src/orchestrator/queue.ts";
import { schedule } from "../src/orchestrator/schedule.ts";
import {
  CAPPED,
  IMPLEMENTS,
  LEGACY_FIXES,
  MERGE_BY_AFTER,
  MERGE_BY_FILES,
  MERGE_LIVE,
  MERGE_NOT_WAITING,
  MERGE_OVER_CHAIN,
  MERGE_OVER_WRITER,
  MERGE_PAST_CHECKS,
  MERGE_TIE,
  mergeBehind,
  NO_RUN,
  NOW,
  READERS,
  SETTINGS,
  SPECS,
  snapshotOf,
  TOKENS_PER_HOUR,
  TWO_IMPLEMENTS,
  WHOLE_REPO_LIVE,
} from "./orchestrator-fixtures.mjs";

/** @import { ScheduleSettings, Snapshot } from "../src/orchestrator/queue.ts" */

// Each decision as `#issue stage action reason`, and a merge's queue, in the
// order made.
/** @param {Snapshot} snapshot @param {ScheduleSettings} [settings] @returns {string[]} */
function decided(snapshot, settings = SETTINGS) {
  return schedule(snapshot, settings, NOW).map((decision) => {
    const { issue, stage, action, reason } = decision;
    let queue = "";
    if (decision.action === "started" && decision.mergeQueue !== null) {
      queue = ` queue:${ranked(decision.mergeQueue).join(",")}`;
    }
    return `#${issue} ${stage} ${action} ${reason}${queue}`;
  });
}

/** @param {readonly number[]} numbers @returns {string[]} */
function ranked(numbers) {
  return numbers.map((n) => `#${n}`);
}

test("readers at every reader stage start together, the later stage first", () => {
  assert.deepEqual(decided(READERS), [
    "#5 security started free",
    "#4 accept started free",
    "#3 review started free",
    "#2 spec started free",
    "#1 triage started free",
  ]);
});

test("each decision carries its time, and a reader's start no merge queue", () => {
  const [first] = schedule(READERS, SETTINGS, NOW);
  assert.deepEqual(first, {
    action: "started",
    at: NOW.toISOString(),
    issue: 5,
    stage: "security",
    reason: "free",
    mergeQueue: null,
    stackOn: null,
  });
});

test("a spec beyond its stage cap is held, counting the live spec job", () => {
  assert.deepEqual(decided(SPECS), [
    "#7 spec started free",
    "#8 spec held stage-cap",
  ]);
});

test("starts beyond maxJobs are held at the global cap", () => {
  assert.deepEqual(decided(READERS, CAPPED), [
    "#5 security started free",
    "#4 accept started free",
    "#3 review held global-cap",
    "#2 spec held global-cap",
    "#1 triage held global-cap",
  ]);
});

test("an implement overlapping a live implementation waits; a disjoint one starts", () => {
  assert.deepEqual(decided(IMPLEMENTS), [
    "#10 review started free",
    "#11 implement held files-overlap:#10",
    "#12 implement started free",
  ]);
});

test("a live implementation without st.files holds every implement", () => {
  assert.deepEqual(decided(WHOLE_REPO_LIVE), [
    "#20 review started free",
    "#21 implement held files-overlap:#20",
  ]);
});

test("of two overlapping implements in one tick, the first starts and holds the second", () => {
  assert.deepEqual(decided(TWO_IMPLEMENTS), [
    "#22 implement started free",
    "#23 implement held files-overlap:#22",
  ]);
});

test("two live overlapping issues at fix: the older starts, so neither deadlocks", () => {
  assert.deepEqual(decided(LEGACY_FIXES), [
    "#30 fix started free",
    "#31 fix held files-overlap:#30",
  ]);
});

test("the merge an issue's after mark waits for ranks first", () => {
  assert.deepEqual(ranked(mergeRank(MERGE_BY_AFTER.issues)), ["#40", "#41"]);
  const merges = decided(MERGE_BY_AFTER).filter((line) =>
    line.includes(" merge "),
  );
  assert.deepEqual(merges, [
    "#40 merge started merge-first queue:#40,#41",
    "#41 merge held merge-order:#40",
  ]);
});

test("the merge a waiting issue's files overlap ranks first", () => {
  assert.deepEqual(ranked(mergeRank(MERGE_BY_FILES.issues)), ["#40", "#41"]);
});

test("issues past implement, stopped or live don't count toward a merge's rank", () => {
  assert.deepEqual(ranked(mergeRank(MERGE_NOT_WAITING.issues)), ["#41", "#40"]);
});

test("merge candidates nothing depends on rank by the lower PR", () => {
  assert.deepEqual(ranked(mergeRank(MERGE_TIE.issues)), ["#51", "#50"]);
  assert.deepEqual(decided(MERGE_TIE), [
    "#50 merge held merge-order:#51",
    "#51 accept started free",
  ]);
});

test("no merge starts while another merge job runs, even the first in the queue", () => {
  assert.deepEqual(ranked(mergeRank(MERGE_LIVE.issues)), ["#61", "#60"]);
  assert.deepEqual(decided(MERGE_LIVE), ["#61 merge held merge-order:#60"]);
});

test("an older merge doesn't hold the writer ranked ahead of it", () => {
  assert.deepEqual(ranked(mergeRank(MERGE_OVER_WRITER.issues)), ["#81", "#80"]);
  assert.deepEqual(decided(MERGE_OVER_WRITER), [
    "#80 merge started merge-first queue:#81,#80",
    "#81 sync started free",
    "#82 spec started free",
  ]);
});

test("an older unqueued writer doesn't hold the queue's first, so no chain deadlocks", () => {
  assert.deepEqual(ranked(mergeRank(MERGE_OVER_CHAIN.issues)), ["#85", "#83"]);
  assert.deepEqual(decided(MERGE_OVER_CHAIN), [
    "#83 merge started merge-first queue:#85,#83",
    "#85 sync started free",
    "#84 fix held files-overlap:#83",
    "#86 spec started free",
  ]);
});

for (const stage of ["sync", "checks"]) {
  test(`an issue ranked ahead at ${stage} doesn't hold a merge, but stays in its queue`, () => {
    assert.deepEqual(decided(mergeBehind(stage)), [
      "#90 merge started merge-first queue:#91,#90",
      `#91 ${stage} started free`,
    ]);
  });
}

for (const stage of ["accept", "security"]) {
  test(`an issue ranked ahead at ${stage} holds a merge`, () => {
    assert.deepEqual(decided(mergeBehind(stage)), [
      "#90 merge held merge-order:#91",
      `#91 ${stage} started free`,
    ]);
  });
}

test("an issue ranked ahead at merge holds a merge and merges first", () => {
  assert.deepEqual(decided(mergeBehind("merge")), [
    "#90 merge held merge-order:#91",
    "#91 merge started merge-first queue:#91,#90",
  ]);
});

test("a merge waits for the first issue at a holding stage, not the queue's top at checks", () => {
  assert.deepEqual(ranked(mergeRank(MERGE_PAST_CHECKS.issues)), [
    "#92",
    "#93",
    "#94",
  ]);
  assert.ok(
    decided(MERGE_PAST_CHECKS).includes("#94 merge held merge-order:#93"),
  );
});

// Every merge fixture, and each stage an issue ranked ahead of a merge is at.
const MERGE_SNAPSHOTS = [
  MERGE_BY_AFTER,
  MERGE_BY_FILES,
  MERGE_NOT_WAITING,
  MERGE_TIE,
  MERGE_LIVE,
  MERGE_OVER_WRITER,
  MERGE_OVER_CHAIN,
  MERGE_PAST_CHECKS,
  ...["sync", "checks", "accept", "security", "merge"].map(mergeBehind),
];
const MERGE_ORDER = /^merge-order:#(?<held>\d+)$/u;

// The merge-order holds in the snapshot's decisions that name neither an
// issue ranked before the held one nor the live merge, and the merges started
// beyond the first.
/** @param {Snapshot} snapshot @returns {string[]} */
function orderBreaks(snapshot) {
  const rank = mergeRank(snapshot.issues);
  const live = snapshot.issues
    .filter(({ job }) => job?.live === true && job.stage === "merge")
    .map(({ number }) => number);
  const decisions = schedule(snapshot, SETTINGS, NOW);
  const holds = decisions.filter(({ action, issue, reason }) => {
    const { held } = MERGE_ORDER.exec(reason)?.groups ?? {};
    if (action !== "held" || held === undefined) {
      return false;
    }
    const at = rank.indexOf(Number(held));
    const own = rank.indexOf(issue);
    const earlier = at >= 0 && (own < 0 || at < own);
    return !(earlier || live.includes(Number(held)));
  });
  const starts = decisions.filter(
    ({ action, stage }) => action === "started" && stage === "merge",
  );
  return [...holds, ...starts.slice(1)].map(
    ({ issue, action, reason }) => `#${issue} ${action} ${reason}`,
  );
}

test("merge-order holds name an issue ranked earlier or the live merge, and one merge starts a tick", () => {
  for (const snapshot of MERGE_SNAPSHOTS) {
    assert.deepEqual(orderBreaks(snapshot), []);
  }
});

test("live, stopped, done and skipped issues get no decision; after marks and other lanes hold", () => {
  assert.deepEqual(decided(NO_RUN), [
    "#76 review held lane:L2",
    "#75 triage held after:#70",
    "#77 triage started free",
    "#78 triage started free",
  ]);
});

test("once the last hour's tokens reach the rate limit, every start is held", () => {
  const spent = snapshotOf([...IMPLEMENTS.issues], TOKENS_PER_HOUR);
  assert.deepEqual(decided(spent), [
    "#10 review held rate-limit",
    "#11 implement held files-overlap:#10",
    "#12 implement held rate-limit",
  ]);
  const under = snapshotOf([...IMPLEMENTS.issues], TOKENS_PER_HOUR - 1);
  assert.deepEqual(decided(under), decided(IMPLEMENTS));
});

test("a tokensPerHour of null or 0 holds no start for the rate limit", () => {
  const spent = snapshotOf([...IMPLEMENTS.issues], TOKENS_PER_HOUR * 2);
  for (const tokensPerHour of [null, 0]) {
    const settings = { ...SETTINGS, tokensPerHour };
    assert.deepEqual(decided(spent, settings), decided(IMPLEMENTS));
  }
});
