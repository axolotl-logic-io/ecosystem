// @ts-check
// The implementor role through a fake RoleContext: a clean run syncs, does
// the work in one committing session, verifies, pushes exactly the verified
// head into the draft PR and goes to review; a branch whose existing change
// already does the Gherkin is adopted as it is; no Gherkin goes to the
// author; `cannot`, failed sessions and failed ops end the stage as they
// should.
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import {
  fakeContext,
  HEAD,
  ISSUE,
  opNames,
  PR,
  ROOT,
  shaOf,
  TEMPORARY_ROOT,
} from "./implementor-test-kit.mjs";
import { ruleCount } from "./load-rule-test-kit.mjs";

const { implementorRole } = await import(
  "../src/roles/implementor/implementor.ts"
);
const { OpsFailure } = await import("../src/job/role-context.ts");

// The ops a model-free role may never run: merging and publishing belong to
// the merge stage, which runs no model.
const MERGE_OPS = new Set(["merge", "publish", "finish-wiki", "ci-status"]);
const MERGED = shaOf("f");
const OPEN_PR_AT = 5;

const GHERKIN_REVISION = /Gherkin revision 2/u;
const SCENARIO = /Scenario: list/u;
const ASSUMPTION = /Chats are sorted newest first/u;
const FINDING = /1\. \[blocking\] \(a\.ts:3\) Sort is wrong/u;
const MERGE_RETURN = /sent the issue back \(ci\):\n\ne2e failed/u;
const AGENTS_FILE = /AGENTS\.md/u;
const PIPELINE_COMMIT = /pipeline_commit/u;
const DOCS_DIR = /docs\//u;
const BUDGET_WORDS = /handoff|budget|context limit/iu;
const NOT_DOABLE_REASON = /could not do the issue as written: no API/u;
const BAD_REPLY = /bad reply/u;
const NOT_VERIFIED_HEAD = /not the verified head/u;
const CHANGES_NOTHING = /changes no file.*Lists chats/u;
const UNREADABLE_REPLY = /reply is not what the role reads/u;
const COMMIT_NOTHING = /commit nothing and say so/u;

test("the tests run under a temporary pipeline root", () => {
  assert.equal(ROOT, TEMPORARY_ROOT);
  assert.ok(TEMPORARY_ROOT.startsWith(os.tmpdir()));
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
  const { title, body, by } = ops[OPEN_PR_AT]?.payload ?? {};
  assert.equal(title, "List chats");
  assert.equal(body, "Lists chats");
  assert.deepEqual(by, { role: "implementor" });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.agent, "issue-pipeline-implementor");
  assert.equal(sessions[0]?.model, ctx.cfg.models.implementor);
  assert.equal(sessions[0]?.commits, true);
  assert.equal(saves.length, 0);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.equal(end.state.pr, PR);
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
  assert.match(task, GHERKIN_REVISION);
  assert.match(task, SCENARIO);
  assert.match(task, ASSUMPTION);
  assert.match(task, FINDING);
  assert.match(task, MERGE_RETURN);
  assert.match(task, AGENTS_FILE);
  assert.match(task, PIPELINE_COMMIT);
  assert.match(task, DOCS_DIR);
  assert.doesNotMatch(task, BUDGET_WORDS);
  assert.equal(ruleCount(task), 1);
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
  assert.match(end.reason, NOT_DOABLE_REASON);
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
  assert.match(stop.reason, BAD_REPLY);
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
        { pr: PR, headSha: shaOf("e"), codeChanged: true, wikiAhead: 0 },
      ],
    },
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "error");
  assert.match(end.reason, NOT_VERIFIED_HEAD);
  assert.equal(end.state.verifiedSha, null);
});

test("a change that lives only in the wiki closes the draft PR and saves no PR", async () => {
  const { ctx, ops } = fakeContext({
    ops: {
      "open-pr": [{ pr: PR, headSha: HEAD, codeChanged: false, wikiAhead: 2 }],
    },
  });
  const end = await implementorRole(ctx);
  assert.equal(opNames(ops).at(-1), "close-pr");
  assert.deepEqual(ops.at(-1)?.payload, { number: ISSUE, pr: PR });
  assert.ok(end.kind === "next");
  assert.deepEqual(end.state.flows, { code: false, wiki: true });
  assert.equal(end.state.pr, null);
});

test("a branch that changes nothing still goes to review, and says so", async () => {
  const { ctx, ops } = fakeContext({
    ops: {
      "open-pr": [{ pr: PR, headSha: HEAD, codeChanged: false, wikiAhead: 0 }],
    },
  });
  const end = await implementorRole(ctx);
  assert.ok(!opNames(ops).includes("close-pr"));
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.deepEqual(end.state.flows, { code: false, wiki: false });
  assert.match(end.state.log.at(-2) ?? "", CHANGES_NOTHING);
});

test("a branch whose existing change already does the Gherkin is adopted: no new edit, verified and sent to review", async () => {
  const summary = "The branch already lists chats; committed nothing";
  const { ctx, ops, sessions } = fakeContext({
    state: { pr: PR, headSha: HEAD },
    sessions: [{ ok: true, reply: { outcome: "done", summary } }],
  });
  const end = await implementorRole(ctx);
  assert.match(sessions[0]?.task ?? "", COMMIT_NOTHING);
  assert.deepEqual(opNames(ops), [
    "start-pr",
    "sync-base",
    "wiki-sync",
    "verify",
    "wiki-check",
    "open-pr",
  ]);
  const { body, reopen } = ops[OPEN_PR_AT]?.payload ?? {};
  assert.equal(body, summary);
  assert.equal(reopen, PR);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.equal(end.state.headSha, HEAD);
  assert.equal(end.state.verifiedSha, HEAD);
  assert.deepEqual(end.state.flows, { code: true, wiki: true });
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
  await assert.rejects(implementorRole(malformed.ctx), {
    name: "OpsFailure",
    op: "verify",
    message: UNREADABLE_REPLY,
  });
});

test("the role never runs a merge or publish op", async () => {
  const runs = [
    fakeContext(),
    fakeContext({
      state: { codeMerged: { pr: PR, sha: MERGED } },
      ops: { verify: [{ pass: true, headSha: MERGED, checks: [] }] },
    }),
  ];
  const ends = await Promise.all(runs.map(({ ctx }) => implementorRole(ctx)));
  for (const end of ends) {
    assert.equal(end.kind, "next");
  }
  for (const name of runs.flatMap(({ ops }) => opNames(ops))) {
    assert.ok(!MERGE_OPS.has(name), `ran ${name}`);
  }
});
