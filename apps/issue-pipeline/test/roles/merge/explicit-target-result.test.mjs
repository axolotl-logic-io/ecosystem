// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { ISSUE, PR, world } from "../../explicit-target-world-test-kit.mjs";
import {
  codeWrites,
  context,
  current,
  NO_FINDING,
  names,
  ownState,
  postmergeOps,
  saves,
  verified,
} from "./explicit-target-role-test-kit.mjs";

const { mergeRole } = await import("../../../src/roles/merge/merge.ts");
const { recoverOwnMerge } = await import(
  "../../../src/roles/merge/recovery.ts"
);
const { afterOwnMerge } = await import(
  "../../../src/roles/merge/after-merge.ts"
);

test("uninterrupted own FF result is confirmed read-only after premerge checks, Security and saving truthful merge, before completion", async () => {
  const w = world({ fastForward: true });
  const run = context(w, {
    state: { security: null },
    ops: {
      "current-revision": [
        current(w),
        current(w),
        current(w),
        current(w, true),
      ],
      "ci-status": [{ status: "pass" }],
      verify: [verified(w)],
      merge: [{ merged: true, headSha: w.head, mergeCommit: w.merged }],
      "confirm-merged": [{ confirmed: true, headSha: w.merged }],
      "prepare-review": [
        {
          headSha: w.head,
          baseSha: w.base,
          diffPath: "diff",
          bundlePath: "bundle",
          changedFiles: ["early.txt", "late.txt"],
        },
      ],
      finish: [{ finished: true, closed: true }],
    },
    sessions: [NO_FINDING],
  });
  const end = await mergeRole(run.ctx);
  assert.equal(end.kind, "next");
  const log = names(run.calls);
  assert.equal(w.merged, w.head);
  assert.ok(log.lastIndexOf("verify") < log.indexOf("merge"));
  assert.ok(log.indexOf("merge") < log.indexOf("confirm-merged"));
  assert.ok(log.indexOf("session") < log.indexOf("merge"));
  assert.equal(log.filter((name) => name === "session").length, 1);
  const saved = saves(run.calls);
  const merged = saved.find((state) => state.merged?.code === w.merged);
  assert.ok(merged !== undefined);
  assert.equal(merged.verifiedSha, w.head);
  const confirmCall = run.calls.find(
    (call) => call.kind === "op" && call.name === "confirm-merged",
  );
  assert.deepEqual(confirmCall, {
    kind: "op",
    name: "confirm-merged",
    payload: { number: ISSUE, codeMerged: { pr: PR, sha: w.merged } },
  });
  const session = run.calls.find((call) => call.kind === "session");
  assert.ok(session?.kind === "session");
  assert.equal(session.spec.commits, false);
  assert.equal(session.spec.phase, "security-review");
  assert.deepEqual(codeWrites(run.calls), []);
});

for (const mode of ["recovered", "uninterrupted"]) {
  for (const failure of ["missing-proof", "wrong-head"]) {
    test(`${mode} own ${failure} confirmation preserves merged truth and stops without suite/security/completion/writer`, async () => {
      const w = world();
      /** @type {Record<string, unknown>} */
      let confirmation = {
        confirmed: false,
        reason: "no premerge check proof binds the merged result",
      };
      if (failure === "wrong-head") {
        confirmation = { confirmed: true, headSha: w.head };
      }
      const run = context(w, {
        state: { ...ownState(w), verifiedSha: w.merged },
        ops: {
          "current-revision": [current(w, true)],
          "confirm-merged": [confirmation],
        },
      });
      let end;
      if (mode === "recovered") {
        end = await recoverOwnMerge(run.ctx, current(w, true));
      } else {
        end = await afterOwnMerge(run.ctx, run.ctx.state, {
          authorized: w.revision,
          mergeCommit: w.merged,
        });
      }
      assert.ok(end?.kind === "stop");
      assert.equal(end.state.merged?.code, w.merged);
      assert.deepEqual(end.state.hardened, w.revision);
      assert.ok(end.reason.includes("code remains merged"));
      assert.ok(names(run.calls).includes("confirm-merged"));
      assert.equal(names(run.calls).includes("verify"), false);
      assert.equal(names(run.calls).includes("session"), false);
      assert.equal(names(run.calls).includes("finish"), false);
      assert.deepEqual(codeWrites(run.calls), []);
    });
  }
}

test("exact own FF recovery confirms M read-only with premerge Security and preserves original-head vs merged provenance", async () => {
  const w = world({ fastForward: true });
  // The candidate's retained target, as the world saved it.
  const target = { repo: w.cfg.repo, branch: w.cfg.baseBranch, sha: w.base };
  const run = context(w, {
    state: {
      ...ownState(w),
      verifiedSha: w.merged,
      security: {
        revision: w.revision,
        phase: "candidate",
        target,
        commentId: PR,
        finding: null,
      },
    },
    ops: {
      finish: postmergeOps(w).finish,
      "confirm-merged": [{ confirmed: true, headSha: w.merged }],
      "current-revision": [current(w, true), current(w, true)],
    },
  });
  const end = await mergeRole(run.ctx);
  assert.ok(end.kind === "next");
  assert.equal(end.state.merged?.code, w.merged);
  assert.deepEqual(end.state.hardened, w.revision);
  assert.deepEqual(end.state.codeMerged, { pr: PR, sha: w.merged });
  assert.equal(names(run.calls).includes("verify"), false);
  assert.equal(names(run.calls).includes("session"), false);
  assert.equal(names(run.calls).includes("merge"), false);
  assert.deepEqual(codeWrites(run.calls), []);
});
