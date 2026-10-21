// @ts-check
// The orchestrator's failing-claim rule (#430) on jobs of this pipeline: the
// third job in a row whose claim fails with one error stops the issue with
// agent:stopped-error at the stage they ran, a different error starts the
// count again, and a claim that passes clears it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { z } from "zod";
import { commentLines } from "../fake-gh.mjs";
import {
  bodyOf,
  effectNames,
  effectsOf,
  stateOf,
} from "../gh-effects-test-kit.mjs";
import {
  collaboratorReply,
  stopMutationReplies,
} from "../gh-mutation-fixtures.mjs";
import {
  cfg,
  fakeGh,
  ghIsRead,
  NOW,
  openWith,
  recordedSpawns,
  resetRuns,
  STATE_ID_BASE,
  stateComment,
  tickOver,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";
import { git, heldCheckout } from "./orchestrator-write-authority-test-kit.mjs";

fakeGh.requireReplies();
const { newIssueState } = await import("../../src/state.ts");
const { readWriteState } = await import("../../src/saved-state.ts");

/** @import { GhEffect } from "../gh-effects-test-kit.mjs" */

const STAGE = "implement";
const STOP_LABEL = "agent:stopped-error";
const MS_PER_SECOND = 1000;
const DEAD_PID = 4343;
const MISSING_ISSUE = 3;
const MALFORMED_ISSUE = 4;
const THREW = "claim threw: GitHub returned a temporary read failure";
const OTHER = "claim threw: gh is not logged in";

const STOPPED = z.looseObject({
  stage: z.literal("stopped"),
  stoppedStage: z.literal("implement"),
  lease: z.null(),
  stopCode: z.literal("error"),
});
const REFUSED =
  /has no saved write authority|saved write authority is invalid/u;
let jobsEnded = 0;

beforeEach(resetRuns);

// One tick after issue `number`'s next job ended, its claim failed with
// `claimError`, or passed when that is null.
/** @param {number} number @param {string | null} claimError @param {object | null} [saved] @returns {{ spawned: string[][], effects: GhEffect[] }} */
function tickAfterJob(
  number,
  claimError,
  saved = { ...newIssueState(number), stage: STAGE },
) {
  jobsEnded += 1;
  /** @type {{ kind: "finished", claimError?: string }} */
  const outcome = { kind: "finished" };
  if (claimError !== null) {
    outcome.claimError = claimError;
  }
  writeJob({
    issue: number,
    stage: STAGE,
    pid: DEAD_PID,
    outcome,
    startedAt: new Date(
      NOW.getTime() + jobsEnded * MS_PER_SECOND,
    ).toISOString(),
  });
  const issue = { number };
  if (saved !== null) {
    Object.assign(issue, { state: saved });
  }
  const replies = [
    collaboratorReply("o/r", "alice"),
    ...stopMutationReplies(number, {
      stateId: STATE_ID_BASE + number,
      pr: null,
      code: "error",
    }),
  ];
  if (saved !== null) {
    replies.push({
      when: `issues/${number}/comments?per_page`,
      stdout: commentLines([stateComment(number, saved)]),
      keep: true,
      // A successful state PATCH must be visible to the stop's reread.
      persistState: true,
    });
  }
  openWith([issue], replies);
  const { spawned } = tickOver();
  return { spawned, effects: effectsOf(fakeGh.writes(ghIsRead)) };
}

/** @param {number} number @param {{ effects: GhEffect[] }} ticked @returns {boolean} */
function stopped(number, { effects }) {
  return effectNames(effects).includes(`label #${number} ${STOP_LABEL}`);
}

test("a claim failing with one error three times in a row stops the issue with the error", () => {
  for (const retried of [tickAfterJob(1, THREW), tickAfterJob(1, THREW)]) {
    assert.equal(stopped(1, retried), false);
    assert.equal(retried.spawned.length, 1);
  }
  const third = tickAfterJob(1, THREW);
  assert.equal(stopped(1, third), true);
  assert.deepEqual(third.spawned, []);
  const text = bodyOf(third.effects, "comment #1 role=coordinator");
  assert.ok(text.includes("claim failed 3 times in a row"), text);
  assert.ok(text.includes(THREW), text);
  const saved = STOPPED.parse(
    stateOf(third.effects, "edit comment 1001 state"),
  );
  assert.equal(saved.stoppedStage, STAGE);
  assert.equal(saved.lease, null);
  assert.deepEqual(readWriteState(cfg, 1), saved);
});

test("a different error starts the count again, and a passing claim clears it", () => {
  tickAfterJob(2, THREW);
  tickAfterJob(2, THREW);
  assert.equal(stopped(2, tickAfterJob(2, OTHER)), false);
  tickAfterJob(2, null);
  tickAfterJob(2, OTHER);
  assert.equal(stopped(2, tickAfterJob(2, OTHER)), false);
});

for (const malformed of [false, true]) {
  test(`orchestrator stop refuses missing/malformed authority=${malformed} without writes and retains exact local work`, () => {
    let number = MISSING_ISSUE;
    /** @type {object | null} */
    let saved = null;
    if (malformed) {
      number = MALFORMED_ISSUE;
      saved = { version: 2, number, stage: STAGE };
    }
    const { wt, origin, local, index, before, refs } = heldCheckout(number);
    for (const initial of [
      tickAfterJob(number, THREW),
      tickAfterJob(number, THREW),
    ]) {
      assert.equal(initial.spawned.length, 1);
    }
    assert.throws(() => tickAfterJob(number, THREW, saved), REFUSED);
    assert.deepEqual(fakeGh.writes(ghIsRead), []);
    assert.deepEqual(recordedSpawns, []);
    assert.equal(git(["-C", origin, "show-ref"]), refs);
    assert.equal(git(["-C", wt, "rev-parse", "HEAD"]), local);
    assert.equal(git(["-C", wt, "show", "HEAD:held.txt"]), "local commit");
    assert.deepEqual(fs.readFileSync(index), before);
    assert.equal(
      fs.readFileSync(path.join(wt, "held.txt"), "utf8"),
      "staged\nunstaged\n",
    );
    assert.equal(
      fs.readFileSync(path.join(wt, "dirty.txt"), "utf8"),
      "untracked bytes\n",
    );
  });
}

test("the first malformed-state reauthor attempt cannot launder critical authority or spawn a job", () => {
  const number = 5;
  const { wt, origin, local, index, before, refs } = heldCheckout(number);
  assert.throws(
    () => tickAfterJob(number, THREW, { version: 2, number, stage: STAGE }),
    REFUSED,
  );
  assert.deepEqual(fakeGh.writes(ghIsRead), []);
  assert.deepEqual(recordedSpawns, []);
  assert.equal(git(["-C", origin, "show-ref"]), refs);
  assert.equal(git(["-C", wt, "rev-parse", "HEAD"]), local);
  assert.deepEqual(fs.readFileSync(index), before);
  assert.equal(
    fs.readFileSync(path.join(wt, "held.txt"), "utf8"),
    "staged\nunstaged\n",
  );
  assert.equal(
    fs.readFileSync(path.join(wt, "dirty.txt"), "utf8"),
    "untracked bytes\n",
  );
});
