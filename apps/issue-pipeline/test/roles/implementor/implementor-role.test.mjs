// @ts-check
// The Developer (the implementor role) through a fake RoleContext: a clean
// run does the work in one committing session, pushes the draft with no
// sync and no verification, and goes to review, clearing any hardening,
// integration or approval of an earlier revision; a branch whose existing
// change already does the Gherkin is pushed as it is; no Gherkin goes to
// the author; `cannot`, failed sessions and failed ops end the stage as
// they should.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fakeContext,
  HEAD,
  INPUTS,
  opNames,
  PR,
  shaOf,
} from "../implementor-test-kit.mjs";

const { implementorRole } = await import(
  "../../../src/roles/implementor/implementor.ts"
);
const { OpsFailure } = await import("../../../src/job/role-context.ts");

// The ops the Developer never runs: synchronizing, verifying, merging and
// completing belong to the Reviewer.
const REVIEWER_OPS = new Set([
  "sync-base",
  "verify",
  "ready-pr",
  "merge",
  "finish",
  "ci-status",
]);
const MERGED = shaOf("f");
const OPEN_PR_AT = 1;

const DEVELOPMENT_TASK = /Task: `development`/u;
const ISSUE_FILE = /Issue file: `\/job\/issue\.md`/u;
const GHERKIN_REVISION = /## Behaviour \(Gherkin revision 2\)/u;
const SCENARIO = /Scenario: list/u;
const ASSUMPTION = /Chats are sorted newest first/u;
const FINDING = /1\. \[blocking\] \(a\.ts:3\) Sort is wrong/u;
const MERGE_RETURN = /Sent back from merge \(ci\)\n\ne2e failed/u;
const BRANCH_SCOPE =
  /Scope: the code branch in `repo\/`, including its docs in `repo\/docs\/`/u;
const MERGED_SCOPE =
  /Scope: none\. The code already merged as PR #\d+, merge commit `[0-9a-f]+`, which `repo\/` holds: commit nothing\./u;
// Behaviour is the prompt page's, never the task's.
const BEHAVIOUR_WORDS =
  /AGENTS\.md|pipeline_commit|artificial load|handoff|budget/iu;
const NOT_DOABLE_REASON = /could not do the issue as written: no API/u;
const BAD_REPLY = /bad reply/u;
const CHANGES_NOTHING = /changes no file.*Lists chats/u;
const UNREADABLE_REPLY = /reply is not what the role reads/u;

const MERGED_RESULT = { code: shaOf("2"), inputs: INPUTS };
const REJECTED = { category: /** @type {const} */ ("rights"), reason: "x" };
const EARLIER = {
  hardened: { code: HEAD, inputs: INPUTS },
  integration: {
    reviewed: { code: HEAD, inputs: INPUTS },
    revision: { code: shaOf("1"), inputs: INPUTS },
  },
  security: { revision: MERGED_RESULT, commentId: 9, finding: null },
  review: {
    round: 0,
    verdict: /** @type {const} */ ("approve"),
    commentId: 5,
    findings: [],
    revision: null,
  },
};

test("a clean run works, pushes the draft with no sync or verify, and goes to review", async () => {
  const { ctx, ops, sessions, saves } = fakeContext({
    state: {
      ...EARLIER,
      mergeReturn: { reason: "retest", detail: "x", codeMerged: false },
    },
  });
  const end = await implementorRole(ctx);
  assert.deepEqual(opNames(ops), ["start-pr", "open-pr"]);
  const { title, body, by } = ops[OPEN_PR_AT]?.payload ?? {};
  assert.equal(title, "List chats");
  assert.equal(body, "Lists chats");
  assert.deepEqual(by, { role: "implementor" });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.agent, "issue-pipeline-implementor");
  assert.equal(sessions[0]?.model, ctx.cfg.models.implementor);
  assert.equal(sessions[0]?.commits, true);
  assert.equal(sessions[0]?.phase, undefined);
  assert.equal(saves.length, 1);
  assert.equal(saves[0]?.pr, PR);
  assert.deepEqual(saves[0]?.hardened, EARLIER.hardened);
  assert.deepEqual(saves[0]?.integration, EARLIER.integration);
  assert.deepEqual(saves[0]?.security, EARLIER.security);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.equal(end.state.pr, PR);
  assert.equal(end.state.headSha, HEAD);
  assert.equal(end.state.verifiedSha, null);
  assert.equal(end.state.hardened, null);
  assert.equal(end.state.integration, null);
  assert.equal(end.state.security, null);
  assert.equal(end.state.review.verdict, null);
  assert.deepEqual(end.state.flows, { code: true });
  assert.equal(end.state.mergeReturn, null);
});

test("a new push keeps a security rejection, which binds the exact merged result it rejected", async () => {
  const security = { revision: MERGED_RESULT, commentId: 9, finding: REJECTED };
  const { ctx } = fakeContext({ state: { ...EARLIER, security } });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "next");
  assert.deepEqual(end.state.security, security);
});

test("the work task carries the facts: the Gherkin, the scope, the findings and the merge's return, no behaviour", async () => {
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
  assert.match(task, DEVELOPMENT_TASK);
  assert.match(task, ISSUE_FILE);
  assert.match(task, BRANCH_SCOPE);
  assert.match(task, GHERKIN_REVISION);
  assert.match(task, SCENARIO);
  assert.match(task, ASSUMPTION);
  assert.match(task, FINDING);
  assert.match(task, MERGE_RETURN);
  assert.doesNotMatch(task, BEHAVIOUR_WORDS);
});

test("after the code merged, the job opens no PR and pushes nothing", async () => {
  const { ctx, ops, sessions } = fakeContext({
    state: { pr: PR, codeMerged: { pr: PR, sha: MERGED } },
  });
  const end = await implementorRole(ctx);
  assert.match(sessions[0]?.task ?? "", MERGED_SCOPE);
  assert.deepEqual(opNames(ops), []);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
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

test("cannot stops not-doable before any push", async () => {
  const { ctx, ops } = fakeContext({
    sessions: [{ ok: true, reply: { outcome: "cannot", reason: "no API" } }],
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "not-doable");
  assert.match(end.reason, NOT_DOABLE_REASON);
  assert.deepEqual(opNames(ops), ["start-pr"]);
});

test("a transient session failure defers, and any other failure stops with error", async () => {
  const deferred = fakeContext({
    sessions: [{ ok: false, transient: true, error: "429" }],
  });
  const end = await implementorRole(deferred.ctx);
  assert.deepEqual(end, { kind: "deferred", error: "429" });
  assert.ok(!opNames(deferred.ops).includes("open-pr"));
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

test("a branch that changes nothing still goes to review, and says so", async () => {
  const { ctx, ops } = fakeContext({
    ops: {
      "open-pr": [{ pr: PR, headSha: HEAD, codeChanged: false }],
    },
  });
  const end = await implementorRole(ctx);
  assert.equal(opNames(ops).at(-1), "open-pr");
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.deepEqual(end.state.flows, { code: false });
  assert.match(end.state.log.at(-2) ?? "", CHANGES_NOTHING);
});

test("a branch whose existing change already does the Gherkin is pushed as it is, and sent to review", async () => {
  const summary = "The branch already lists chats; committed nothing";
  const { ctx, ops } = fakeContext({
    state: { pr: PR, headSha: HEAD },
    sessions: [{ ok: true, reply: { outcome: "done", summary } }],
  });
  const end = await implementorRole(ctx);
  assert.deepEqual(opNames(ops), ["start-pr", "open-pr"]);
  const { body, reopen } = ops[OPEN_PR_AT]?.payload ?? {};
  assert.equal(body, summary);
  assert.equal(reopen, PR);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.equal(end.state.headSha, HEAD);
  assert.deepEqual(end.state.flows, { code: true });
});

test("a failed op propagates as its OpsFailure, and a malformed reply fails", async () => {
  const failure = new OpsFailure("open-pr", 1, "network down");
  const failed = fakeContext({ ops: { "open-pr": [failure] } });
  await assert.rejects(implementorRole(failed.ctx), failure);
  const malformed = fakeContext({ ops: { "open-pr": [{ pr: PR }] } });
  await assert.rejects(implementorRole(malformed.ctx), {
    name: "OpsFailure",
    op: "open-pr",
    message: UNREADABLE_REPLY,
  });
});

test("the Developer never syncs, verifies, readies, merges or completes", async () => {
  const runs = [
    fakeContext(),
    fakeContext({
      state: { codeMerged: { pr: PR, sha: MERGED } },
    }),
  ];
  const ends = await Promise.all(runs.map(({ ctx }) => implementorRole(ctx)));
  for (const end of ends) {
    assert.equal(end.kind, "next");
  }
  for (const name of runs.flatMap(({ ops }) => opNames(ops))) {
    assert.ok(!REVIEWER_OPS.has(name), `ran ${name}`);
  }
});
