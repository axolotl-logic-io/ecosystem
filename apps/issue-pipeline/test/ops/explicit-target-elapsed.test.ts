import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../../src/config.ts";
import {
  calls,
  consumed,
  post,
  prechecks,
  prStep,
  request,
  script,
} from "../explicit-target-test-kit.ts";
import type { World } from "../explicit-target-world-test-kit.ts";
import { git, ISSUE, world } from "../explicit-target-world-test-kit.ts";
import { targetPushes } from "../fake-pipeline-flow-gh-native.ts";
import { confirmationClock } from "./confirmation-clock-test-kit.ts";
import {
  confirmation,
  expectedTargetPush,
  mergeComment,
  posts,
  staleConfirmation,
} from "./explicit-target-recovery-test-kit.ts";

const { merge }: typeof import("../../src/ops/merge.ts") = await import(
  "../../src/ops/merge.ts"
);
const { reconcileMerge }: typeof import("../../src/ops/merge-recovery.ts") =
  await import("../../src/ops/merge-recovery.ts");
const { readWriteState }: typeof import("../../src/saved-state.ts") =
  await import("../../src/saved-state.ts");
const { readWriteAuthority }: typeof import("../../src/write-authority.ts") =
  await import("../../src/write-authority.ts");
const { testConfig }: typeof import("../config-test-kit.ts") = await import(
  "../config-test-kit.ts"
);
const { mergeConfirmation: defaults }: Config = testConfig().cfg;
const DEADLINE_MS = 90_000;
const LONG_LAG_MS = 65_000;
const SHORT_LAG_MS = 7000;
const SECOND_MS = 1000;
const SECOND_WAIT_MS = 2000;
const THIRD_WAIT_MS = 4000;
const FOURTH_WAIT_MS = 8000;
const FINAL_WAIT_MS = 10_000;
const CLIPPED_WAIT_MS = 5000;
const LATER_RUN_DELAY_MS = 60_000;
const CUSTOM_DEADLINE_SECONDS = 9;
const CUSTOM_WAIT_SECONDS = 3;
const CUSTOM_READS = 4;
const WAITS_TO_LAG: number[] = [
  SECOND_MS,
  SECOND_WAIT_MS,
  THIRD_WAIT_MS,
  FOURTH_WAIT_MS,
  FINAL_WAIT_MS,
  FINAL_WAIT_MS,
  FINAL_WAIT_MS,
  FINAL_WAIT_MS,
  FINAL_WAIT_MS,
];
const WAITS_TO_DEADLINE: number[] = [
  ...WAITS_TO_LAG,
  FINAL_WAIT_MS,
  FINAL_WAIT_MS,
  CLIPPED_WAIT_MS,
];
const BOUNDED =
  /confirmation deadline reached.*90s.*may already have landed|may already have landed.*confirmation deadline reached.*90s/u;

function approvalCount(): number {
  return calls().filter((args) => args.includes("event=APPROVE")).length;
}

function elapsedWorld(): World {
  const w = world({ fastForward: true });
  git(w.origin, ["config", "core.logAllRefUpdates", "true"]);
  return w;
}

for (const delay of [
  {
    lag: LONG_LAG_MS,
    name: "stale CLOSED",
    extra: { state: "CLOSED", mergeCommit: null },
    code: 0,
  },
  {
    lag: SHORT_LAG_MS,
    name: "missing result",
    extra: { state: "MERGED", mergeCommit: null },
    code: 0,
  },
  { lag: SHORT_LAG_MS, name: "unreadable metadata", extra: {}, code: 1 },
]) {
  test(`${delay.name} for ${delay.lag}ms confirms with default spaced waits and one approval and POST`, () => {
    const w = elapsedWorld();
    assert.equal(git(w.origin, ["rev-parse", w.cfg.baseBranch]), w.base);
    assert.deepEqual(targetPushes(w.origin, w.cfg.baseBranch), []);
    assert.ok(w.state.security);
    assert.equal(w.state.security.phase, "candidate");
    w.cfg.mergeConfirmation = defaults;
    const clock = confirmationClock();
    const expectedWaits: number[] = [];
    let availableAt = 0;
    for (const wait of WAITS_TO_LAG) {
      if (availableAt >= delay.lag) {
        break;
      }
      expectedWaits.push(wait);
      availableAt += wait;
    }
    script(w, [
      ...prechecks(w),
      post(w),
      ...expectedWaits.map(() => ({
        ...prStep(w, delay.extra),
        code: delay.code,
      })),
      ...confirmation(w),
      mergeComment(w),
    ]);
    assert.deepEqual(merge(w.cfg, request(w), clock), {
      merged: true,
      mergeCommit: w.merged,
      headSha: w.head,
    });
    assert.equal(clock.now(), delay.lag);
    assert.deepEqual(clock.waits, expectedWaits);
    const saved = readWriteState(w.cfg, ISSUE);
    assert.equal(saved.mergeAttempt?.reads, expectedWaits.length + 1);
    assert.equal(saved.merged?.code, w.merged);
    assert.deepEqual(saved.hardened, w.state.hardened);
    assert.deepEqual(saved.integration, w.state.integration);
    assert.deepEqual(saved.security, w.state.security);
    assert.equal(git(w.origin, ["rev-parse", w.cfg.baseBranch]), w.head);
    assert.deepEqual(targetPushes(w.origin, w.cfg.baseBranch), [
      expectedTargetPush(w),
    ]);
    assert.equal(posts().length, 1);
    assert.equal(approvalCount(), 1);
    consumed();
  });
}

test("default deadline stops durably but later matching evidence recovers the same saved attempt read-only", () => {
  const w = elapsedWorld();
  assert.equal(git(w.origin, ["rev-parse", w.cfg.baseBranch]), w.base);
  assert.deepEqual(targetPushes(w.origin, w.cfg.baseBranch), []);
  assert.ok(w.state.security);
  assert.equal(w.state.security.phase, "candidate");
  w.cfg.mergeConfirmation = defaults;
  const { clock, reply } = staleConfirmation(w, WAITS_TO_DEADLINE);
  assert.equal(reply.merged, false);
  assert.ok("reason" in reply);
  assert.match(reply.reason, BOUNDED);
  assert.equal(clock.now(), DEADLINE_MS);
  assert.deepEqual(clock.waits, WAITS_TO_DEADLINE);
  const expired = readWriteState(w.cfg, ISSUE);
  assert.equal(expired.mergeAttempt?.result, w.merged);
  assert.equal(expired.mergeAttempt?.authorized.code, w.head);
  assert.equal(expired.mergeAttempt?.reads, WAITS_TO_DEADLINE.length);
  assert.equal(expired.merged, null);
  assert.deepEqual(expired.security, w.state.security);
  assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
  assert.equal(git(w.origin, ["rev-parse", w.cfg.baseBranch]), w.head);
  assert.deepEqual(targetPushes(w.origin, w.cfg.baseBranch), [
    expectedTargetPush(w),
  ]);
  consumed();

  // This is a separate, explicitly caller-authorized run, not an automatic
  // restart loop. Earlier elapsed windows and spent reads remain evidence.
  const later = confirmationClock(DEADLINE_MS + LATER_RUN_DELAY_MS);
  script(w, confirmation(w), true);
  assert.deepEqual(reconcileMerge(w.cfg, { number: ISSUE }, later), {
    merged: true,
    mergeCommit: w.merged,
    headSha: w.head,
  });
  assert.deepEqual(later.waits, []);
  const saved = readWriteState(w.cfg, ISSUE);
  assert.deepEqual(saved.mergeAttempt, {
    ...expired.mergeAttempt,
    reads: WAITS_TO_DEADLINE.length + 1,
  });
  assert.equal(saved.merged?.code, w.merged);
  assert.deepEqual(saved.hardened, expired.hardened);
  assert.deepEqual(saved.integration, expired.integration);
  assert.deepEqual(saved.security, w.state.security);
  assert.equal(git(w.origin, ["rev-parse", w.cfg.baseBranch]), w.head);
  assert.deepEqual(targetPushes(w.origin, w.cfg.baseBranch), [
    expectedTargetPush(w),
  ]);
  assert.equal(posts().length, 1);
  assert.equal(approvalCount(), 1);
  consumed();
});

test("evidence reads finishing after the deadline retain landed truth for a later run, not a late own receipt", () => {
  const w = elapsedWorld();
  assert.equal(git(w.origin, ["rev-parse", w.cfg.baseBranch]), w.base);
  assert.deepEqual(targetPushes(w.origin, w.cfg.baseBranch), []);
  w.cfg.mergeConfirmation = defaults;
  let samples = 0;
  const clock = confirmationClock();
  function now(): 90000 | 0 {
    samples += 1;
    if (samples > 2) {
      return DEADLINE_MS;
    }
    return 0;
  }
  script(w, [...prechecks(w), post(w), ...confirmation(w)]);
  const reply = merge(w.cfg, request(w), { ...clock, now });
  assert.equal(reply.merged, false);
  const saved = readWriteState(w.cfg, ISSUE);
  assert.equal(saved.merged, null);
  assert.equal(saved.codeMerged?.sha, w.merged);
  assert.equal(saved.mergeAttempt?.result, w.merged);
  assert.deepEqual(clock.waits, []);
  assert.deepEqual(saved.security, w.state.security);
  assert.equal(git(w.origin, ["rev-parse", w.cfg.baseBranch]), w.head);
  assert.deepEqual(targetPushes(w.origin, w.cfg.baseBranch), [
    expectedTargetPush(w),
  ]);
  consumed();
  script(w, confirmation(w), true);
  assert.equal(
    reconcileMerge(w.cfg, { number: ISSUE }, confirmationClock()).merged,
    true,
  );
  assert.equal(readWriteState(w.cfg, ISSUE).merged?.code, w.merged);
  assert.deepEqual(readWriteState(w.cfg, ISSUE).security, w.state.security);
  assert.equal(git(w.origin, ["rev-parse", w.cfg.baseBranch]), w.head);
  assert.deepEqual(targetPushes(w.origin, w.cfg.baseBranch), [
    expectedTargetPush(w),
  ]);
  assert.equal(posts().length, 1);
  assert.equal(approvalCount(), 1);
  consumed();
});

test("configured backoff repeats its final wait and clips it at the finite deadline", () => {
  const w = elapsedWorld();
  assert.equal(git(w.origin, ["rev-parse", w.cfg.baseBranch]), w.base);
  assert.deepEqual(targetPushes(w.origin, w.cfg.baseBranch), []);
  w.cfg.mergeConfirmation = {
    deadlineSeconds: CUSTOM_DEADLINE_SECONDS,
    backoffSeconds: [2, CUSTOM_WAIT_SECONDS],
  };
  const clock = confirmationClock();
  script(w, [
    ...prechecks(w),
    post(w),
    ...Array.from({ length: CUSTOM_READS }, () =>
      prStep(w, { state: "CLOSED", mergeCommit: null }),
    ),
  ]);
  assert.equal(merge(w.cfg, request(w), clock).merged, false);
  assert.deepEqual(clock.waits, [
    SECOND_WAIT_MS,
    CUSTOM_WAIT_SECONDS * SECOND_MS,
    CUSTOM_WAIT_SECONDS * SECOND_MS,
    SECOND_MS,
  ]);
  assert.equal(clock.now(), CUSTOM_DEADLINE_SECONDS * SECOND_MS);
  const saved = readWriteState(w.cfg, ISSUE);
  assert.equal(saved.mergeAttempt?.reads, CUSTOM_READS);
  assert.equal(saved.mergeAttempt?.result, w.head);
  assert.deepEqual(saved.security, w.state.security);
  assert.equal(git(w.origin, ["rev-parse", w.cfg.baseBranch]), w.head);
  assert.deepEqual(targetPushes(w.origin, w.cfg.baseBranch), [
    expectedTargetPush(w),
  ]);
  assert.equal(posts().length, 1);
  assert.equal(approvalCount(), 1);
  consumed();
});
