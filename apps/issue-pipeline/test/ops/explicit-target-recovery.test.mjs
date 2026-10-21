// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  calls,
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
  commit,
  git,
  ISSUE,
  ISSUE_DATA,
  PR,
  REPO,
  world,
} from "../explicit-target-world-test-kit.mjs";
import { confirmationClock } from "./confirmation-clock-test-kit.mjs";
import {
  child,
  confirmation,
  interruptAfterResponse,
  mergeComment,
  posts,
} from "./explicit-target-recovery-test-kit.mjs";

const { merge } = await import("../../src/ops/merge.ts");
const { reconcileMerge } = await import("../../src/ops/merge-recovery.ts");
const { readWriteState, stateBody } = await import("../../src/saved-state.ts");
const { saveState } = await import("../../src/ops/save-state.ts");
const { verify } = await import("../../src/ops/verify.ts");
const { mergedCode } = await import("../../src/ops/merged-review.ts");
const INPUT_MOVEMENT = /trusted inputs no longer match/u;
const OK = z.looseObject({
  ok: z.literal(true),
  merged: z.literal(true),
  mergeCommit: z.string(),
  byHand: z.boolean().optional(),
});
for (const delay of [
  { name: "stale CLOSED", extra: { state: "CLOSED", mergeCommit: null } },
  { name: "missing result", extra: { state: "MERGED", mergeCommit: null } },
  {
    name: "malformed result",
    extra: { state: "MERGED", mergeCommit: { oid: "bad" } },
  },
  { name: "unreadable metadata", code: 1, extra: {} },
]) {
  test(`${delay.name} then exact evidence confirms one own merge within the finite bound`, () => {
    const w = world({ fastForward: true });
    script(w, [
      ...prechecks(w),
      post(w),
      { ...prStep(w, delay.extra), code: delay.code ?? 0 },
      ...confirmation(w),
      mergeComment(w),
    ]);
    assert.deepEqual(merge(w.cfg, request(w), confirmationClock()), {
      merged: true,
      mergeCommit: w.merged,
      headSha: w.head,
    });
    consumed();
    const saved = readWriteState(w.cfg, ISSUE);
    assert.equal(saved.merged?.code, w.merged);
    assert.equal(saved.mergeAttempt?.reads, 2);
    assert.equal(saved.mergeAttempt?.result, w.merged);
    assert.equal(posts().length, 1);
    assert.deepEqual(saved.hardened, w.state.hardened);
    assert.deepEqual(saved.integration, w.state.integration);
    assert.deepEqual(saved.security, w.state.security);
  });
}

test("actual result M survives a later target tip and checks/security read M and P..M", () => {
  const w = world({ concurrent: true });
  const { interrupted, saved: original } = interruptAfterResponse(w);
  assert.equal(
    interrupted.signal,
    "SIGKILL",
    `${interrupted.stdout} ${interrupted.stderr}`,
  );
  assert.equal(original.mergeAttempt?.result, w.merged);
  assert.equal(original.merged, null);
  git(w.seed, ["checkout", "-q", BASE]);
  const later = commit(w.seed, "later.txt", "later integration\n");
  git(w.seed, ["push", "-q", "origin", `${later}:refs/heads/${BASE}`]);
  script(w, confirmation(w), true);
  assert.deepEqual(
    reconcileMerge(w.cfg, { number: ISSUE }, confirmationClock()),
    {
      merged: true,
      mergeCommit: w.merged,
      headSha: w.head,
    },
  );
  assert.equal(readWriteState(w.cfg, ISSUE).merged?.code, w.merged);
  assert.equal(posts().length, 0);
  consumed();
  script(
    w,
    [prStep(w, mergedView(w), true), prStep(w, mergedView(w), true)],
    true,
  );
  const checked = verify(w.cfg, {
    number: ISSUE,
    codeMerged: { pr: PR, sha: w.merged },
  });
  assert.equal(checked.headSha, w.merged);
  assert.equal(checked.pass, true);
  consumed();
  script(
    w,
    [prStep(w, mergedView(w), true), prStep(w, mergedView(w), true)],
    true,
  );
  const reviewed = mergedCode(w.cfg, ISSUE, { pr: PR, sha: w.merged });
  assert.deepEqual(reviewed.range, { from: w.parent, head: w.merged });
  assert.deepEqual(reviewed.files, ["early.txt", "late.txt"]);
  assert.equal(fs.existsSync(path.join(w.wt, "later.txt")), false);
  assert.equal(posts().length, 0);
  consumed();
});

test("interruption after durable 201 response recovers in a new process without another POST", () => {
  const w = world({ fastForward: true });
  const reviewed = {
    ...w.revision,
    code: git(w.wt, ["rev-parse", `${w.head}~1`]),
  };
  const { interrupted, saved: attempted } = interruptAfterResponse(w);
  assert.ok(attempted.mergeAttempt !== null);
  // Synthetic pre-upgrade attempt: the original hardening authorized its
  // own checked integration, and Security had not run before the old POST.
  const integration = { reviewed, revision: w.revision };
  const original = {
    ...attempted,
    hardened: reviewed,
    integration,
    security: null,
    mergeAttempt: {
      ...attempted.mergeAttempt,
      hardened: reviewed,
      integration,
    },
  };
  fs.writeFileSync(
    path.join(w.place, "state.json"),
    stateBody(ISSUE, original),
  );
  assert.equal(
    interrupted.signal,
    "SIGKILL",
    `${interrupted.stdout} ${interrupted.stderr}`,
  );
  assert.equal(original.mergeAttempt.result, w.merged);
  assert.equal(original.merged, null);
  assert.deepEqual(original.hardened, reviewed);
  assert.equal(posts().length, 1);
  script(w, confirmation(w), true);
  const resumed = child(w, { op: "reconcile-merge", number: ISSUE });
  assert.equal(resumed.status, 0, resumed.stderr);
  const reply = OK.parse(JSON.parse(resumed.stdout));
  assert.equal(reply.mergeCommit, w.merged);
  assert.equal(reply.byHand, undefined);
  const saved = readWriteState(w.cfg, ISSUE);
  assert.deepEqual(saved.hardened, original.hardened);
  assert.deepEqual(saved.integration, original.integration);
  assert.equal(saved.merged?.code, w.merged);
  assert.equal(posts().length, 1);
  assert.equal(
    calls().some((args) => args[0] === "pr" && args[1] === "merge"),
    false,
  );
  consumed();
});

for (const finding of [
  null,
  { category: /** @type {const} */ ("rights"), reason: "unsafe" },
]) {
  test(`a stale job snapshot cannot erase a confirmed receipt or exact security decision: ${JSON.stringify(finding)}`, () => {
    const w = world({ fastForward: true });
    script(w, [...prechecks(w), post(w), ...confirmation(w), mergeComment(w)]);
    assert.equal(merge(w.cfg, request(w), confirmationClock()).merged, true);
    const confirmed = readWriteState(w.cfg, ISSUE);
    assert.ok(confirmed.merged !== null);
    const security = {
      revision: confirmed.merged,
      commentId: PR,
      finding,
    };
    saveState(w.cfg, { number: ISSUE, state: { ...confirmed, security } });
    saveState(w.cfg, { number: ISSUE, state: w.state });
    const retained = readWriteState(w.cfg, ISSUE);
    assert.deepEqual(retained.merged, confirmed.merged);
    assert.deepEqual(retained.security, security);
    assert.deepEqual(retained.codeMerged, { pr: PR, sha: w.merged });
    assert.deepEqual(retained.mergeAttempt, confirmed.mergeAttempt);
    assert.deepEqual(retained.hardened, w.state.hardened);
    assert.equal(posts().length, 1);
    consumed();
  });
}

test("trusted input movement during delayed confirmation retains landed truth but cannot create an own receipt", () => {
  const w = world({ fastForward: true });
  const changed = confirmation(w).map((step) => {
    if (step.args[1] === `repos/${REPO}/issues/${ISSUE}`) {
      return {
        ...step,
        stdout: JSON.stringify({
          ...ISSUE_DATA,
          body: "changed after authorization",
        }),
      };
    }
    return step;
  });
  script(w, [
    ...prechecks(w),
    post(w),
    ...Array.from({ length: 3 }, () => changed).flat(),
  ]);
  const reply = merge(w.cfg, request(w), confirmationClock());
  assert.equal(reply.merged, false);
  assert.ok("reason" in reply);
  assert.match(reply.reason, INPUT_MOVEMENT);
  const saved = readWriteState(w.cfg, ISSUE);
  assert.equal(saved.merged, null);
  assert.deepEqual(saved.security, w.state.security);
  assert.equal(saved.codeMerged?.sha, w.merged);
  assert.equal(saved.mergeAttempt?.result, w.merged);
  assert.equal(posts().length, 1);
  consumed();
});
