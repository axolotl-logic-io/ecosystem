// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  child,
  interruptAfterResponse,
  posts,
} from "./explicit-target-recovery-test-kit.mjs";
import {
  consumed,
  mergedView,
  post,
  prechecks,
  prStep,
  request,
  script,
} from "./explicit-target-test-kit.mjs";
import {
  BASE,
  git,
  ISSUE,
  PR,
  world,
} from "./explicit-target-world-test-kit.mjs";

const { merge } = await import("../src/ops/merge.ts");
const { reconcileMerge } = await import("../src/ops/merge-recovery.ts");
const { readWriteState } = await import("../src/saved-state.ts");
const { saveState } = await import("../src/ops/save-state.ts");
const { readWriteAuthority } = await import("../src/write-authority.ts");
const { resumeOf } = await import("../src/state.ts");
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
const TOTAL_READS = 6;
test("exhausted reads and lifted stops retain attempted authority and never permit another POST or code writer", () => {
  const w = world();
  function open() {
    return prStep(w, { state: "OPEN", mergeCommit: null });
  }
  script(w, [...prechecks(w), post(w), ...Array.from({ length: 3 }, open)]);
  assert.match(REFUSED.parse(merge(w.cfg, request(w))).reason, BOUNDED);
  const uncertain = readWriteState(w.cfg, ISSUE);
  assert.equal(uncertain.mergeAttempt?.reads, READS_PER_RUN);
  assert.equal(uncertain.merged, null);
  assert.equal(uncertain.security, null);
  assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
  // Stale job releases cannot erase the response or spent budget.
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
    REFUSED.parse(reconcileMerge(w.cfg, { number: ISSUE })).reason,
    BOUNDED,
  );
  assert.equal(readWriteState(w.cfg, ISSUE).mergeAttempt?.reads, TOTAL_READS);
  consumed();
  script(w, [], true);
  assert.match(
    REFUSED.parse(reconcileMerge(w.cfg, { number: ISSUE })).reason,
    BOUNDED,
  );
  assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
  consumed();
  // Even a direct stale merge request with fresh-looking OPEN cannot POST.
  script(w, prechecks(w).slice(0, -2), true);
  assert.deepEqual(merge(w.cfg, request(w)), {
    merged: false,
    reason: "behind",
  });
  assert.equal(posts().length, 1);
  assert.equal(readWriteState(w.cfg, ISSUE).merged, null);
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
    const w = world();
    script(w, [
      ...prechecks(w),
      post(w),
      ...Array.from({ length: 3 }, () =>
        prStep(w, { ...mergedView(w), ...defect }),
      ),
    ]);
    assert.match(REFUSED.parse(merge(w.cfg, request(w))).reason, BOUNDED);
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
  "HTTP/2.0 204 No Content\r\n\r\n",
  "",
  "malformed HTTP",
  "HTTP/2.0 201 Created\r\n\r\nnot JSON",
  "HTTP/2.0 201 Created\r\n\r\n{}",
]) {
  test(`missing saved successful response remains external on restart: ${JSON.stringify(response)}`, () => {
    const w = world();
    script(w, [...prechecks(w), post(w, { stdout: response })]);
    assert.equal(merge(w.cfg, request(w)).merged, false);
    assert.equal(readWriteState(w.cfg, ISSUE).mergeAttempt?.result, null);
    script(w, [prStep(w, mergedView(w))], true);
    const resumed = child(w, { op: "reconcile-merge", number: ISSUE });
    const reply = OK.parse(JSON.parse(resumed.stdout));
    assert.equal(reply.byHand, true);
    const saved = readWriteState(w.cfg, ISSUE);
    assert.equal(saved.merged, null);
    assert.deepEqual(saved.codeMerged, { pr: PR, sha: w.merged });
    assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
    assert.equal(posts().length, 1);
    consumed();
  });
}

test("interruption before response save never recovers own provenance from metadata alone", () => {
  const w = world();
  script(w, [...prechecks(w), post(w, { interrupt: true })]);
  const stopped = child(w, { ...request(w), op: "merge" });
  assert.equal(
    stopped.signal,
    "SIGKILL",
    `${stopped.stdout} ${stopped.stderr}`,
  );
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.merged);
  assert.equal(readWriteState(w.cfg, ISSUE).mergeAttempt?.result, null);
  script(w, [prStep(w, mergedView(w))], true);
  assert.deepEqual(reconcileMerge(w.cfg, { number: ISSUE }), {
    merged: true,
    byHand: true,
    mergeCommit: w.merged,
    headSha: w.head,
  });
  assert.equal(readWriteState(w.cfg, ISSUE).merged, null);
  assert.equal(posts().length, 1);
  consumed();
});

test("interruption spends a durable pass and abusive repeated process restarts cannot renew the lifetime budget", () => {
  const w = world();
  const { interrupted, saved } = interruptAfterResponse(w);
  assert.equal(interrupted.signal, "SIGKILL");
  assert.equal(saved.mergeAttempt?.reads, 1);
  assert.equal(saved.mergeAttempt?.result, w.merged);
  const afterInterruptedRestart = TOTAL_READS - 1 - READS_PER_RUN;
  for (const remaining of [READS_PER_RUN, afterInterruptedRestart, 0]) {
    script(
      w,
      Array.from({ length: remaining }, () =>
        prStep(w, { state: "OPEN", mergeCommit: null }),
      ),
      true,
    );
    const resumed = child(w, { op: "reconcile-merge", number: ISSUE });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(REFUSED.parse(JSON.parse(resumed.stdout)).reason, BOUNDED);
    const current = readWriteState(w.cfg, ISSUE);
    assert.equal(current.merged, null);
    assert.equal(current.security, null);
    assert.equal(posts().length, 1);
    consumed();
  }
  const exhausted = readWriteState(w.cfg, ISSUE);
  assert.equal(exhausted.mergeAttempt?.reads, TOTAL_READS);
  assert.deepEqual(exhausted.hardened, saved.hardened);
  assert.deepEqual(exhausted.integration, saved.integration);
  assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
});
