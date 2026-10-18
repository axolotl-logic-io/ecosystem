// @ts-check
// The implementor role through a fake RoleContext: a clean run syncs, does
// the work in one committing session, verifies, pushes exactly the verified
// head into the draft PR and goes to review; no Gherkin goes to the author;
// `cannot`, failed sessions and failed ops end the stage as they should.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertTemporaryRoot,
  fakeContext,
  HEAD,
  ISSUE,
  opNames,
} from "./implementor-test-kit.mjs";

const { implementorRole } = await import(
  "../src/roles/implementor/implementor.ts"
);
const { OpsFailure } = await import("../src/job/role-context.ts");

// The ops a model-free role may never run: merging and publishing belong to
// the merge stage, which runs no model.
const MERGE_OPS = new Set(["merge", "publish", "finish-wiki", "ci-status"]);
const MERGED = "f".repeat(40);

test("the tests run under a temporary pipeline root", () => {
  assertTemporaryRoot();
});

test("a clean run syncs, works, verifies, pushes the verified head and goes to review", async () => {
  const { ctx, ops, sessions, saves } = fakeContext({
    state: {
      mergeReturn: { reason: "retest", detail: "x", codeMerged: false },
    },
  });
  const end = await implementorRole(ctx);
  assert.deepEqual(opNames(ops), [
    "start-pr",
    "sync-base",
    "wiki-sync",
    "verify",
    "wiki-check",
    "open-pr",
  ]);
  assert.deepEqual(ops[1]?.payload, { number: ISSUE, keepConflict: true });
  assert.deepEqual(ops[3]?.payload, { number: ISSUE });
  const open = ops[5]?.payload;
  assert.equal(open?.["title"], "List chats");
  assert.equal(open?.["body"], "Lists chats");
  assert.deepEqual(open?.["by"], { role: "implementor" });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.agent, "issue-pipeline-implementor");
  assert.equal(sessions[0]?.model, ctx.cfg.models.implementor);
  assert.equal(sessions[0]?.commits, true);
  assert.equal(saves.length, 0);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.equal(end.state.pr, 12);
  assert.equal(end.state.headSha, HEAD);
  assert.equal(end.state.verifiedSha, HEAD);
  assert.deepEqual(end.state.flows, { code: true, wiki: true });
  assert.equal(end.state.mergeReturn, null);
});

test("the work task carries the Gherkin, the findings, the merge's return and the rules", async () => {
  const { ctx, sessions } = fakeContext({
    state: {
      review: {
        round: 1,
        verdict: "changes",
        commentId: 5,
        findings: [
          {
            id: 1,
            severity: "blocking",
            text: "Sort is wrong",
            path: "a.ts",
            line: 3,
          },
        ],
        revision: null,
      },
      mergeReturn: { reason: "ci", detail: "e2e failed", codeMerged: false },
    },
  });
  await implementorRole(ctx);
  const task = sessions[0]?.task ?? "";
  assert.match(task, /Gherkin revision 2/u);
  assert.match(task, /Scenario: list/u);
  assert.match(task, /Chats are sorted newest first/u);
  assert.match(task, /1\. \[blocking\] \(a\.ts:3\) Sort is wrong/u);
  assert.match(task, /sent the issue back \(ci\):\n\ne2e failed/u);
  assert.match(task, /AGENTS\.md/u);
  assert.match(task, /pipeline_commit/u);
  assert.match(task, /docs\//u);
  assert.doesNotMatch(task, /handoff|budget|context limit/iu);
});

test("an issue with no Gherkin goes to the author and comes back to implement", async () => {
  const { ctx, ops, sessions } = fakeContext({ gherkin: null });
  const end = await implementorRole(ctx);
  assert.equal(ops.length, 0);
  assert.equal(sessions.length, 0);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "author");
  assert.equal(end.state.resumeStage, "implement");
});

test("cannot stops not-doable before any verify or push", async () => {
  const { ctx, ops } = fakeContext({
    sessions: [{ ok: true, reply: { outcome: "cannot", reason: "no API" } }],
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "not-doable");
  assert.match(end.reason, /could not do the issue as written: no API/u);
  assert.deepEqual(opNames(ops), ["start-pr", "sync-base", "wiki-sync"]);
});

test("a transient session failure defers, and any other failure stops with error", async () => {
  const deferred = fakeContext({
    sessions: [{ ok: false, transient: true, error: "429" }],
  });
  const end = await implementorRole(deferred.ctx);
  assert.deepEqual(end, { kind: "deferred", error: "429" });
  assert.ok(!opNames(deferred.ops).includes("verify"));
  const failed = fakeContext({
    sessions: [{ ok: false, transient: false, error: "bad reply" }],
  });
  const stop = await implementorRole(failed.ctx);
  assert.ok(stop.kind === "stop");
  assert.equal(stop.code, "error");
  assert.match(stop.reason, /bad reply/u);
});

test("a resolver's reply to the work task stops with error", async () => {
  const { ctx } = fakeContext({
    sessions: [
      { ok: true, reply: { outcome: "conflict-resolved", summary: "x" } },
    ],
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop" && end.code === "error");
});

test("a push of anything but the verified head saves no verified head", async () => {
  const { ctx } = fakeContext({
    ops: {
      "open-pr": [
        { pr: 12, headSha: "e".repeat(40), codeChanged: true, wikiAhead: 0 },
      ],
    },
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "error");
  assert.match(end.reason, /not the verified head/u);
  assert.equal(end.state.verifiedSha, null);
});

test("a change that lives only in the wiki closes the draft PR", async () => {
  const { ctx, ops } = fakeContext({
    ops: {
      "open-pr": [{ pr: 12, headSha: HEAD, codeChanged: false, wikiAhead: 2 }],
    },
  });
  const end = await implementorRole(ctx);
  assert.equal(opNames(ops).at(-1), "close-pr");
  assert.deepEqual(ops.at(-1)?.payload, { number: ISSUE, pr: 12 });
  assert.ok(end.kind === "next");
  assert.deepEqual(end.state.flows, { code: false, wiki: true });
});

test("a branch that changes nothing still goes to review, and says so", async () => {
  const { ctx, ops } = fakeContext({
    ops: {
      "open-pr": [{ pr: 12, headSha: HEAD, codeChanged: false, wikiAhead: 0 }],
    },
  });
  const end = await implementorRole(ctx);
  assert.ok(!opNames(ops).includes("close-pr"));
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.deepEqual(end.state.flows, { code: false, wiki: false });
  assert.match(end.state.log.at(-2) ?? "", /changes no file.*Lists chats/u);
});

test("a repo with no wiki skips the wiki sync", async () => {
  const { ctx, ops } = fakeContext({ docs: null });
  await implementorRole(ctx);
  assert.ok(!opNames(ops).includes("wiki-sync"));
  assert.ok(opNames(ops).includes("wiki-check"));
});

test("a failed op propagates as its OpsFailure, and a malformed reply fails", async () => {
  const failure = new OpsFailure("verify", 1, "network down");
  const failed = fakeContext({ ops: { verify: [failure] } });
  await assert.rejects(implementorRole(failed.ctx), failure);
  const malformed = fakeContext({ ops: { verify: [{ pass: true }] } });
  await assert.rejects(implementorRole(malformed.ctx), /verify op's reply/u);
});

test("the role never runs a merge or publish op", async () => {
  const runs = [
    fakeContext(),
    fakeContext({
      state: { codeMerged: { pr: 12, sha: MERGED } },
      ops: { verify: [{ pass: true, headSha: MERGED, checks: [] }] },
    }),
  ];
  for (const { ctx, ops } of runs) {
    const end = await implementorRole(ctx);
    assert.equal(end.kind, "next");
    for (const name of opNames(ops)) {
      assert.ok(!MERGE_OPS.has(name), `ran ${name}`);
    }
  }
});
