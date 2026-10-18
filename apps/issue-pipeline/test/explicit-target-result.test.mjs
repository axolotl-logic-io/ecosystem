// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
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
  WIKI_PASS,
} from "./explicit-target-role-test-kit.mjs";
import { ISSUE, PR, world } from "./explicit-target-world-test-kit.mjs";

const { mergeRole } = await import("../src/roles/merge/merge.ts");
const { recoverOwnMerge } = await import("../src/roles/merge/recovery.ts");
const { afterOwnMerge } = await import("../src/roles/merge/publish.ts");

test("uninterrupted own result checks M after saving truthful merge and before read-only security/completion", async () => {
  const w = world({ concurrent: true });
  const run = context(w, {
    ops: {
      "current-revision": [
        current(w),
        current(w),
        current(w, true),
        current(w, true),
      ],
      "ci-status": [{ status: "pass" }],
      "wiki-check": [WIKI_PASS, WIKI_PASS],
      verify: [verified(w)],
      merge: [{ merged: true, headSha: w.head, mergeCommit: w.merged }],
      "prepare-review": postmergeOps(w)["prepare-review"],
      "finish-wiki": [{ finished: true, closed: true }],
    },
    sessions: [NO_FINDING],
  });
  const end = await mergeRole(run.ctx);
  assert.equal(end.kind, "next");
  const log = names(run.calls);
  assert.ok(log.indexOf("merge") < log.indexOf("verify"));
  assert.ok(log.indexOf("verify") < log.indexOf("prepare-review"));
  assert.ok(
    log.indexOf("wiki-check", log.indexOf("verify")) < log.indexOf("session"),
  );
  const saved = saves(run.calls);
  assert.equal(saved[0]?.merged?.code, w.merged);
  assert.equal(saved[0]?.verifiedSha, w.head);
  assert.ok(saved.some((state) => state.verifiedSha === w.merged));
  const verifiedCall = run.calls.find(
    (call) => call.kind === "op" && call.name === "verify",
  );
  assert.deepEqual(verifiedCall, {
    kind: "op",
    name: "verify",
    payload: { number: ISSUE, codeMerged: { pr: PR, sha: w.merged } },
  });
  const session = run.calls.find((call) => call.kind === "session");
  assert.ok(session?.kind === "session");
  assert.equal(session.spec.commits, false);
  assert.equal(session.spec.phase, "security-review");
  assert.deepEqual(codeWrites(run.calls), []);
});

for (const mode of ["recovered", "uninterrupted"]) {
  for (const failure of ["code", "wiki", "wrong-head"]) {
    test(`${mode} own ${failure} check failure preserves merged truth and stops without security/wiki/completion/writer`, async () => {
      const w = world();
      let check = verified(w);
      let wiki = WIKI_PASS;
      if (failure === "code") {
        check = {
          pass: false,
          headSha: w.merged,
          checks: [{ id: "test", pass: false, detail: "exit 1" }],
        };
      }
      if (failure === "wiki") {
        wiki = {
          pass: false,
          checks: [{ id: "wiki", pass: false, detail: "bad link" }],
        };
      }
      if (failure === "wrong-head") {
        check = { ...verified(w), headSha: w.head };
      }
      const run = context(w, {
        state: { ...ownState(w), verifiedSha: w.merged },
        ops: {
          "current-revision": [current(w, true)],
          verify: [check],
          "wiki-check": [wiki],
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
      assert.ok(names(run.calls).includes("verify"));
      assert.equal(names(run.calls).includes("session"), false);
      assert.equal(names(run.calls).includes("publish"), false);
      assert.equal(names(run.calls).includes("finish-wiki"), false);
      assert.deepEqual(codeWrites(run.calls), []);
    });
  }
}

test("exact own recovery checks M even with cached verified M and preserves original-head vs merged provenance", async () => {
  const w = world();
  const run = context(w, {
    state: { ...ownState(w), verifiedSha: w.merged },
    ops: {
      ...postmergeOps(w),
      "current-revision": [current(w, true), current(w, true)],
    },
    sessions: [NO_FINDING],
  });
  const end = await mergeRole(run.ctx);
  assert.ok(end.kind === "next");
  assert.equal(end.state.merged?.code, w.merged);
  assert.deepEqual(end.state.hardened, w.revision);
  assert.deepEqual(end.state.codeMerged, { pr: PR, sha: w.merged });
  assert.equal(names(run.calls).filter((name) => name === "verify").length, 1);
  assert.equal(names(run.calls).includes("merge"), false);
  assert.deepEqual(codeWrites(run.calls), []);
});
