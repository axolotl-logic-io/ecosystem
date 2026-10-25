import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { ReviewedTarget } from "../../src/reviewed-target.ts";
import {
  calls,
  consumed,
  prechecks,
  request,
  script,
} from "../explicit-target-test-kit.ts";
import {
  BASE,
  BRANCH,
  git,
  ISSUE,
  PR,
  world,
} from "../explicit-target-world-test-kit.ts";
import { confirmationClock } from "./confirmation-clock-test-kit.ts";
import {
  confirmation,
  posts,
  retainLegacyAttempt,
} from "./explicit-target-recovery-test-kit.ts";

const { merge }: typeof import("../../src/ops/merge.ts") = await import(
  "../../src/ops/merge.ts"
);
const { reconcileMerge }: typeof import("../../src/ops/merge-recovery.ts") =
  await import("../../src/ops/merge-recovery.ts");
const { beginMerge }: typeof import("../../src/ops/merge-attempt.ts") =
  await import("../../src/ops/merge-attempt.ts");
const { readWriteState, stateBody }: typeof import("../../src/saved-state.ts") =
  await import("../../src/saved-state.ts");
const { readWriteAuthority }: typeof import("../../src/write-authority.ts") =
  await import("../../src/write-authority.ts");
const BAD_REQUEST = /bad merge request/u;
const NO_AUTHORIZATION = /no fresh unattempted saved authorization/u;
const CHANGED_AUTHORIZATION =
  /original hardening\/integration authorization changed/u;
const INITIAL_REVISION_READS = 5;

for (const base of [undefined, "HEAD", "1234"]) {
  test(`expected old target ${String(base)} must be an explicit immutable SHA before any reads`, () => {
    const w = world({ fastForward: true });
    script(w, []);
    assert.throws(
      () => merge(w.cfg, { ...request(w), expectedBase: base }),
      BAD_REQUEST,
    );
    assert.deepEqual(calls(), []);
    assert.equal(readWriteState(w.cfg, ISSUE).mergeAttempt, null);
    consumed();
  });
}

for (const change of ["target", "missing", "repo", "branch", "sha"]) {
  test(`retained target ${change} mismatch refuses even an ancestor target before approval or intent`, () => {
    const w = world({ fastForward: true });
    if (change === "target") {
      git(w.origin, [
        "update-ref",
        `refs/heads/${BASE}`,
        git(w.wt, ["rev-parse", `${w.head}~1`]),
      ]);
    } else {
      let target: ReviewedTarget | null = {
        repo: w.cfg.repo,
        branch: BASE,
        sha: w.base,
      };
      if (change === "repo") {
        target = { ...target, repo: "other/repo" };
      }
      if (change === "branch") {
        target = { ...target, branch: "main" };
      }
      if (change === "sha") {
        target = { ...target, sha: w.head };
      }
      if (change === "missing") {
        target = null;
      }
      w.state.hardenedTarget = target;
      fs.writeFileSync(
        path.join(w.place, "state.json"),
        stateBody(ISSUE, w.state),
      );
    }
    script(w, prechecks(w).slice(0, INITIAL_REVISION_READS));
    assert.deepEqual(merge(w.cfg, request(w)), {
      merged: false,
      reason: "target-changed",
    });
    assert.equal(readWriteState(w.cfg, ISSUE).mergeAttempt, null);
    assert.equal(
      calls().some(
        (args) => args.includes("push") || args.includes("event=APPROVE"),
      ),
      false,
    );
    consumed();
  });
}

test("the intent checkpoint rereads the retained reviewed target rather than trusting an old precheck", () => {
  const w = world({ fastForward: true });
  w.state.hardenedTarget = { repo: w.cfg.repo, branch: BASE, sha: w.head };
  fs.writeFileSync(path.join(w.place, "state.json"), stateBody(ISSUE, w.state));
  script(w, []);
  assert.throws(
    () =>
      beginMerge(w.cfg, ISSUE, PR, { authorized: w.revision, base: w.base }),
    NO_AUTHORIZATION,
  );
  assert.equal(readWriteState(w.cfg, ISSUE).mergeAttempt, null);
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
  consumed();
});

test("an armed attempt with changed retained target remains read-only and cannot gain an own receipt", () => {
  const w = world({ fastForward: true });
  const state = {
    ...w.state,
    hardenedTarget: { repo: w.cfg.repo, branch: BASE, sha: w.head },
    mergeAttempt: {
      repo: w.cfg.repo,
      pr: PR,
      target: BASE,
      branch: BRANCH,
      authorized: w.revision,
      hardened: w.revision,
      integration: null,
      operation: { kind: "fast-forward" as const, base: w.base },
      result: null,
      reads: 0,
    },
  };
  fs.writeFileSync(path.join(w.place, "state.json"), stateBody(ISSUE, state));
  git(w.origin, ["update-ref", `refs/heads/${BASE}`, w.head]);
  script(w, []);
  const reply = reconcileMerge(w.cfg, { number: ISSUE }, confirmationClock());
  assert.ok(!reply.merged);
  assert.match(reply.reason, CHANGED_AUTHORIZATION);
  const saved = readWriteState(w.cfg, ISSUE);
  assert.equal(saved.merged, null);
  assert.equal(saved.codeMerged?.sha, w.head);
  assert.deepEqual(saved.mergeAttempt?.operation, state.mergeAttempt.operation);
  assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
  assert.equal(posts().length, 0);
  consumed();
});

test("a genuine legacy two-parent attempt recovers without inventing a historical reviewed target", () => {
  const w = world({ concurrent: true });
  w.state.hardenedTarget = null;
  retainLegacyAttempt(w);
  script(w, confirmation(w));
  assert.deepEqual(
    reconcileMerge(w.cfg, { number: ISSUE }, confirmationClock()),
    {
      merged: true,
      mergeCommit: w.merged,
      headSha: w.head,
    },
  );
  const saved = readWriteState(w.cfg, ISSUE);
  assert.equal(saved.hardenedTarget, null);
  assert.equal(saved.mergeAttempt?.operation, undefined);
  assert.equal(saved.merged?.code, w.merged);
  assert.equal(posts().length, 0);
  consumed();
});
