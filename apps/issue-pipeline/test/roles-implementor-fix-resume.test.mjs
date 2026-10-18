// @ts-check
// Where locate starts an implementor run saved at `fix` (#418,
// `every-role-resumes`): at the shared `start`, which takes the `fix` entry,
// whatever phase today's fix stage saved it in; with its round count and its
// fixer continuations kept from today's `round` and `continuations.fix`, or
// the role's checkpoints when they are higher; and with the review's
// hand-off fields read back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findingsText } from "../src/workflow/findings.ts";
import { outOfRoomReason } from "../src/workflow/stages/continuation.ts";
import {
  F1,
  FIX_HANDOFF,
  fixLocated,
  fixStepFrom,
  REVIEWED,
  remainReason,
} from "./implementor-fix-test-kit.mjs";
import {
  HANDOFF_FILE,
  located,
  stoppedWith,
} from "./implementor-role-test-kit.mjs";
import { UNCHANGED } from "./implementor-sync-test-kit.mjs";

/** @import { State } from "../src/state.ts" */

// A finding id past the review's, and the security rounds run.
const NEXT_ID = 4;
const SECURITY_ROUNDS = 1;

// Today's fix stage's phases; none is saved, but a state may carry one.
const OLD_PHASES = [
  "begin",
  "fixed",
  "pushed",
  "repushed",
  "flowed",
  "prepared",
  "rereviewed",
  "saved",
];

test("a run saved at fix starts at start with the fix entry, whatever phase it was in, and goes to fix-work? through the start sync (#419)", () => {
  for (const phase of [undefined, ...OLD_PHASES]) {
    const { at, data } = fixLocated({ phase });
    assert.equal(at, "start", String(phase));
    assert.equal(data.entry, "fix", String(phase));
    const step = fixStepFrom("start", "fix", null, data);
    assert.equal(step.state.at, "sync-work?", String(phase));
    const synced = fixStepFrom("sync-work?", "fix", UNCHANGED, data);
    assert.equal(synced.state.at, "fix-work?", String(phase));
  }
  assert.equal(located().data.entry, "implement");
});

test("the round count is today's round or the role's checkpoint, whichever is higher, and round mirrors it", () => {
  /** @type {[State, number][]} */
  const cases = [
    [{ round: 2 }, 2],
    [{ round: 1, checkpoints: { fixRounds: 0 } }, 1],
    [{ round: 0, checkpoints: { fixRounds: 2 } }, 2],
    [{ round: undefined }, 0],
    [{ round: 0 }, 0],
  ];
  for (const [saved, count] of cases) {
    const { data } = fixLocated(saved);
    assert.equal(data.fixRounds, count, JSON.stringify(saved));
    assert.equal(data.round, count, JSON.stringify(saved));
  }
});

test("the fixer's continuations are today's continuations.fix or the role's checkpoint, apart from the implementer's", () => {
  /** @type {[State, number][]} */
  const cases = [
    [{ continuations: { fix: 1 } }, 1],
    [{ continuations: { implement: 1 } }, 0],
    [{ continuations: 1 }, 0],
    [{ checkpoints: { fixContinuations: 1 }, continuations: {} }, 1],
    [{ checkpoints: { fixContinuations: 0 }, continuations: { fix: 1 } }, 1],
    [{}, 0],
  ];
  for (const [saved, count] of cases) {
    const { data } = fixLocated(saved);
    assert.equal(data.fixContinuations, count, JSON.stringify(saved));
  }
  const implement = fixLocated({ continuations: { implement: 1, fix: 0 } });
  assert.equal(implement.data.continuations, 1);
});

test("locate reads back the review's hand-off: the reviewed head and patch id, the finding ids, the resolved history, the security rounds and the stack", () => {
  const stackedOn = { issue: 5, headSha: "ppppppp" };
  const { data } = fixLocated({
    reviewedPatchId: "p0",
    nextFindingId: NEXT_ID,
    resolvedHistory: ["f0: Old bug"],
    testsOnly: true,
    prClosed: true,
    securityRounds: SECURITY_ROUNDS,
    stackedOn,
  });
  assert.equal(data.reviewedSha, REVIEWED);
  assert.equal(data.reviewedPatchId, "p0");
  assert.equal(data.nextFindingId, NEXT_ID);
  assert.deepEqual(data.resolvedHistory, ["f0: Old bug"]);
  assert.equal(data.testsOnly, true);
  assert.equal(data.prClosed, true);
  assert.equal(data.securityRounds, SECURITY_ROUNDS);
  assert.deepEqual(data.stackedOn, stackedOn);
  assert.deepEqual(data.findings, [F1]);
});

test("an old state saved mid-round at its last round stops on its open findings without running the fixer", () => {
  const { data } = fixLocated({ round: 2, phase: "rereviewed" });
  const step = fixStepFrom("fix-work?", "open", null, data);
  assert.equal(step.state.at, "findings-open");
  assert.deepEqual(step.effect, {
    kind: "end",
    end: stoppedWith("review-rounds", remainReason(2), findingsText([F1])),
  });
});

test("an old state at its last fixer continuation stops as too large on its next handoff", () => {
  const { data } = fixLocated({ round: 1, continuations: { fix: 1 } });
  const step = fixStepFrom("fixer-reply", "handoff", null, {
    ...data,
    fixReply: FIX_HANDOFF,
  });
  assert.equal(step.state.at, "fixer-out-of-room");
  assert.deepEqual(step.effect, {
    kind: "end",
    end: stoppedWith(
      "too-large",
      outOfRoomReason("fixer", 1),
      `Latest handoff: ${HANDOFF_FILE}\n\n${FIX_HANDOFF.summary}`,
    ),
  });
});
