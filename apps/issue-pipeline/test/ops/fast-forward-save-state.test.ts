// Isolated source-module save/release tests. No ops CLI or job child.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Security } from "../../src/state.ts";
import { calls, consumed } from "../explicit-target-test-kit.ts";
import { BASE, git, ISSUE, PR } from "../explicit-target-world-test-kit.ts";
import { posts } from "./explicit-target-recovery-test-kit.ts";
import { confirmedLostResponse } from "./fast-forward-save-state-test-kit.ts";

const { readWriteState }: typeof import("../../src/saved-state.ts") =
  await import("../../src/saved-state.ts");
const { release, saveState }: typeof import("../../src/ops/save-state.ts") =
  await import("../../src/ops/save-state.ts");
const { policyRevision }: typeof import("../../src/project-policy.ts") =
  await import("../../src/project-policy.ts");
const { securityRefusal }: typeof import("../../src/security-clearance.ts") =
  await import("../../src/security-clearance.ts");
const RIGHTS_REFUSAL = /security review stopped.*rights/u;
const { readWriteAuthority }: typeof import("../../src/write-authority.ts") =
  await import("../../src/write-authority.ts");

test("a real landed FF with lost acknowledgement saves only the exact intent receipt, not a response", async () => {
  const { w, confirmed, reviewed, resultSecurity, reply } =
    await confirmedLostResponse(null);
  assert.ok(w.state.security);
  assert.deepEqual(reviewed.security, w.state.security);
  assert.deepEqual(reviewed.resultSecurity, {
    revision: { ...w.revision, ...policyRevision(w.cfg) },
    target: w.state.hardenedTarget,
    commentId: PR,
    finding: null,
  });
  assert.notEqual(resultSecurity.revision.policy, w.revision.policy);
  assert.deepEqual(reply, {
    merged: true,
    mergeCommit: w.head,
    headSha: w.head,
  });
  assert.ok(confirmed.mergeAttempt !== null);
  assert.equal(confirmed.mergeAttempt.result, null);
  assert.deepEqual(confirmed.mergeAttempt.operation, {
    kind: "fast-forward",
    base: w.base,
  });
  assert.deepEqual(confirmed.merged, w.revision);
  assert.deepEqual(confirmed.codeMerged, { pr: PR, sha: w.head });
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.head);
  consumed();
});

for (const finding of [
  null,
  { category: "rights" as const, reason: "unsafe result" },
]) {
  for (const boundary of ["save-state", "release"]) {
    test(`${boundary} retains the lost-response FF receipt and exact decision: ${JSON.stringify(finding)}`, async () => {
      const { w, confirmed, resultSecurity, reviewed } =
        await confirmedLostResponse(finding);
      assert.deepEqual(reviewed.security, w.state.security);
      assert.deepEqual(reviewed.resultSecurity, {
        revision: { ...w.revision, ...policyRevision(w.cfg) },
        target: w.state.hardenedTarget,
        commentId: PR,
        finding,
      });
      assert.notEqual(resultSecurity.revision.policy, w.revision.policy);
      assert.equal(w.state.merged, null);
      assert.ok(w.state.security);
      assert.equal(w.state.security.phase, "candidate");
      assert.deepEqual(w.state.security.revision, w.revision);
      assert.deepEqual(w.state.security.target, w.state.hardenedTarget);
      assert.equal(w.state.security.finding, null);
      const stale = {
        number: ISSUE,
        state: w.state,
        lane: "lost-response",
        sweepId: "stale-job",
      };
      if (boundary === "release") {
        release(w.cfg, stale);
      } else {
        saveState(w.cfg, stale);
      }
      const retained = readWriteState(w.cfg, ISSUE);
      assert.deepEqual(retained.merged, confirmed.merged);
      assert.deepEqual(retained.security, w.state.security);
      assert.deepEqual(retained.resultSecurity, resultSecurity);
      assert.deepEqual(retained.codeMerged, confirmed.codeMerged);
      assert.deepEqual(retained.mergeAttempt, confirmed.mergeAttempt);
      assert.deepEqual(retained.hardened, confirmed.hardened);
      assert.deepEqual(retained.hardenedTarget, confirmed.hardenedTarget);
      assert.deepEqual(retained.integration, confirmed.integration);
      assert.equal(retained.mergeAttempt?.result, null);
      assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
      assert.equal(git(w.origin, ["rev-parse", BASE]), w.head);
      assert.equal(posts().length, 1);
      assert.equal(
        calls().filter((args) => args.includes("event=APPROVE")).length,
        1,
      );
      consumed();
    });
  }
}

test("a rights result rejection stops despite candidate clearance and survives a stale clearance save", async () => {
  const finding: NonNullable<Security["finding"]> = {
    category: "rights",
    reason: "unsafe result",
  };
  const { w, confirmed, resultSecurity, reviewed, review } =
    await confirmedLostResponse(finding);
  assert.ok(w.state.security);
  assert.deepEqual(reviewed.security, w.state.security);
  assert.deepEqual(reviewed.resultSecurity, {
    revision: { ...w.revision, ...policyRevision(w.cfg) },
    target: w.state.hardenedTarget,
    commentId: PR,
    finding,
  });
  assert.notEqual(resultSecurity.revision.policy, w.revision.policy);
  assert.equal(review.ok, false);
  assert.ok("end" in review);
  assert.equal(review.end.kind, "stop");
  assert.ok("code" in review.end);
  assert.equal(review.end.code, "rights");
  assert.match(
    securityRefusal(reviewed, resultSecurity.revision) ?? "",
    RIGHTS_REFUSAL,
  );
  saveState(w.cfg, {
    number: ISSUE,
    state: {
      ...confirmed,
      resultSecurity: { ...resultSecurity, finding: null },
    },
  });
  const retained = readWriteState(w.cfg, ISSUE);
  assert.deepEqual(retained.security, w.state.security);
  assert.deepEqual(retained.resultSecurity, resultSecurity);
  assert.match(
    securityRefusal(retained, resultSecurity.revision) ?? "",
    RIGHTS_REFUSAL,
  );
  assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.head);
  assert.equal(posts().length, 1);
  assert.equal(
    calls().filter((args) => args.includes("event=APPROVE")).length,
    1,
  );
  consumed();
});
