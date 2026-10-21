// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  consumed,
  mergedView,
  post,
  prechecks,
  prStep,
  request,
  script,
} from "../explicit-target-test-kit.mjs";
import {
  BASE,
  git,
  ISSUE,
  PR,
  world,
} from "../explicit-target-world-test-kit.mjs";
import { confirmationClock } from "./confirmation-clock-test-kit.mjs";
import {
  child,
  confirmation,
  interruptAfterResponse,
  posts,
} from "./explicit-target-recovery-test-kit.mjs";

const { merge } = await import("../../src/ops/merge.ts");
const { reconcileMerge } = await import("../../src/ops/merge-recovery.ts");
const { readWriteState } = await import("../../src/saved-state.ts");
const { saveState } = await import("../../src/ops/save-state.ts");
const { readWriteAuthority } = await import("../../src/write-authority.ts");
const { resumeOf } = await import("../../src/state.ts");
const REFUSED = z.object({ merged: z.literal(false), reason: z.string() });
const OK = z.looseObject({
  ok: z.literal(true),
  merged: z.literal(true),
  mergeCommit: z.string(),
  byHand: z.boolean().optional(),
});
const BOUNDED =
  /bounded merge recovery.*may already have landed.*another merge POST.*not authorized/u;
const SHA_LENGTH = 40;
const READS_PER_RUN = 3;
const EXPIRED_RUNS = 3;
test("elapsed deadlines and lifted stops retain attempted authority and never permit another POST or code writer", () => {
  const w = world({ fastForward: true });
  function open() {
    return prStep(w, { state: "CLOSED", mergeCommit: null });
  }
  script(w, [...prechecks(w), post(w), ...Array.from({ length: 3 }, open)]);
  assert.match(
    REFUSED.parse(merge(w.cfg, request(w), confirmationClock())).reason,
    BOUNDED,
  );
  const uncertain = readWriteState(w.cfg, ISSUE);
  assert.equal(uncertain.mergeAttempt?.reads, READS_PER_RUN);
  assert.equal(uncertain.merged, null);
  assert.equal(uncertain.security, null);
  assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
  // Stale job releases cannot erase the response or cumulative read evidence.
  saveState(w.cfg, { number: ISSUE, state: w.state });
  assert.deepEqual(
    readWriteState(w.cfg, ISSUE).mergeAttempt,
    uncertain.mergeAttempt,
  );
  const lifted = resumeOf({
    ...uncertain,
    stage: "stopped",
    stoppedStage: "merge",
    stopCode: "merge-refused",
  });
  saveState(w.cfg, { number: ISSUE, state: lifted });
  script(w, Array.from({ length: 3 }, open), true);
  assert.match(
    REFUSED.parse(reconcileMerge(w.cfg, { number: ISSUE }, confirmationClock()))
      .reason,
    BOUNDED,
  );
  assert.equal(
    readWriteState(w.cfg, ISSUE).mergeAttempt?.reads,
    READS_PER_RUN * 2,
  );
  consumed();
  // A direct stale merge request must recover read-only, before approval,
  // even after what used to be the six-read lifetime cap.
  script(w, confirmation(w), true);
  assert.deepEqual(merge(w.cfg, request(w), confirmationClock()), {
    merged: true,
    mergeCommit: w.merged,
    headSha: w.head,
  });
  assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
  assert.equal(posts().length, 1);
  assert.equal(readWriteState(w.cfg, ISSUE).merged?.code, w.merged);
  consumed();
});

for (const defect of [
  { url: null },
  { url: "not a URL" },
  { url: "https://github.com/other/repo/pull/50" },
  { url: "https://github.com/example/repo/pull/51" },
  { number: "50" },
  { baseRefName: "main" },
  { headRefName: "other" },
  { headRefOid: "d".repeat(SHA_LENGTH) },
  { mergeCommit: null },
  { mergeCommit: { oid: "bad" } },
  { mergeCommit: { oid: "f".repeat(SHA_LENGTH) } },
]) {
  test(`invalid identity/result cannot create an own receipt: ${JSON.stringify(defect)}`, () => {
    const w = world({ fastForward: true });
    script(w, [
      ...prechecks(w),
      post(w),
      ...Array.from({ length: 3 }, () =>
        prStep(w, { ...mergedView(w), ...defect }),
      ),
    ]);
    assert.match(
      REFUSED.parse(merge(w.cfg, request(w), confirmationClock())).reason,
      BOUNDED,
    );
    const saved = readWriteState(w.cfg, ISSUE);
    assert.equal(saved.merged, null);
    assert.equal(saved.security, null);
    assert.equal(saved.mergeAttempt?.result, w.merged);
    assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
    assert.equal(posts().length, 1);
    consumed();
  });
}

for (const response of [
  "connection lost",
  "timeout",
  "empty ack",
  "malformed ack",
  "missing ack",
]) {
  test(`missing push response confirms only its authenticated exact intent on restart: ${response}`, () => {
    const w = world({ fastForward: true });
    script(w, [
      ...prechecks(w),
      post(w, { skipMutation: true, code: 1, stderr: response }),
    ]);
    assert.equal(merge(w.cfg, request(w), confirmationClock()).merged, false);
    assert.equal(readWriteState(w.cfg, ISSUE).mergeAttempt?.result, null);
    git(w.origin, ["update-ref", `refs/heads/${BASE}`, w.head]);
    script(w, confirmation(w), true);
    const resumed = child(w, { op: "reconcile-merge", number: ISSUE });
    const reply = OK.parse(JSON.parse(resumed.stdout));
    assert.equal(reply.byHand, undefined);
    const saved = readWriteState(w.cfg, ISSUE);
    assert.equal(saved.merged?.code, w.head);
    assert.deepEqual(saved.codeMerged, { pr: PR, sha: w.head });
    assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
    assert.equal(posts().length, 1);
    consumed();
  });
}

test("interruption before response save recovers exact intended FF without another mutation", () => {
  const w = world({ fastForward: true });
  script(w, [...prechecks(w), post(w, { interrupt: true })]);
  const stopped = child(w, { ...request(w), op: "merge" });
  assert.equal(
    stopped.signal,
    "SIGKILL",
    `${stopped.stdout} ${stopped.stderr}`,
  );
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.merged);
  assert.equal(readWriteState(w.cfg, ISSUE).mergeAttempt?.result, null);
  script(w, confirmation(w), true);
  assert.deepEqual(
    reconcileMerge(w.cfg, { number: ISSUE }, confirmationClock()),
    {
      merged: true,
      mergeCommit: w.merged,
      headSha: w.head,
    },
  );
  assert.equal(readWriteState(w.cfg, ISSUE).merged?.code, w.head);
  assert.equal(posts().length, 1);
  consumed();
});

test("interruption retains cumulative read evidence without permanently expiring later bounded recovery", () => {
  const w = world({ fastForward: true });
  const { interrupted, saved } = interruptAfterResponse(w);
  assert.equal(interrupted.signal, "SIGKILL");
  assert.equal(saved.mergeAttempt?.reads, 1);
  assert.equal(saved.mergeAttempt?.result, w.merged);
  for (let run = 1; run <= EXPIRED_RUNS; run += 1) {
    script(
      w,
      Array.from({ length: READS_PER_RUN }, () =>
        prStep(w, { state: "CLOSED", mergeCommit: null }),
      ),
      true,
    );
    const resumed = child(w, { op: "reconcile-merge", number: ISSUE });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(REFUSED.parse(JSON.parse(resumed.stdout)).reason, BOUNDED);
    const current = readWriteState(w.cfg, ISSUE);
    assert.equal(current.mergeAttempt?.reads, 1 + run * READS_PER_RUN);
    assert.equal(current.merged, null);
    assert.equal(current.security, null);
    assert.equal(posts().length, 1);
    consumed();
  }
  script(w, confirmation(w), true);
  const resumed = child(w, { op: "reconcile-merge", number: ISSUE });
  assert.equal(OK.parse(JSON.parse(resumed.stdout)).mergeCommit, w.merged);
  const confirmed = readWriteState(w.cfg, ISSUE);
  assert.equal(confirmed.mergeAttempt?.reads, 2 + EXPIRED_RUNS * READS_PER_RUN);
  assert.deepEqual(confirmed.hardened, saved.hardened);
  assert.deepEqual(confirmed.integration, saved.integration);
  assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
  assert.equal(posts().length, 1);
  consumed();
});
