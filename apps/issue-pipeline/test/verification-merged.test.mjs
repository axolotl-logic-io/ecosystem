// @ts-check
// Verification once the issue's code merged (`state.codeMerged`), as the
// Reviewer runs it on wiki-only work: verify runs the repo's checks on
// exactly the merge commit and wiki-check the pending wiki; a failure on the
// merged code stops with check-fixes and no session, and a wiki failure
// gets fix sessions scoped to docs/ only. The Developer's own wiki-only
// work pushes the wiki alone and runs no code op.
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import {
  BASE,
  fakeContext,
  ISSUE,
  opNames,
  PR,
  ROOT,
  shaOf,
  TEMPORARY_ROOT,
} from "./implementor-test-kit.mjs";

const { implementorRole } = await import(
  "../src/roles/implementor/implementor.ts"
);
const { verifiedHead } = await import("../src/roles/verification.ts");

const MERGED = shaOf("f");
const CODE_MERGED = { pr: PR, sha: MERGED };
const BRANCH_HEAD = shaOf("e");
const VERIFIED = { pass: true, headSha: MERGED, checks: [] };
const CODE_FAILS = {
  pass: false,
  headSha: MERGED,
  checks: [{ id: "test", pass: false, detail: "exit 1" }],
};
const WIKI_FAILS = {
  pass: false,
  checks: [{ id: "wiki-link:Chats", pass: false, detail: "dead link" }],
};
const WIKI_PASSES = { pass: true, checks: [] };
const PUSHED = { headSha: BRANCH_HEAD, codeChanged: true, wikiAhead: 1 };
// The ops wiki-only work may never make: they touch the code branch or PR.
const CODE_OPS = new Set([
  "start-pr",
  "sync-base",
  "finish-sync",
  "open-pr",
  "close-pr",
]);

const MERGED_PR = /code already merged as PR #12, merge commit `f{40}`/u;
const DOCS_ONLY = /Scope: the wiki in `docs\/` only/u;
const BRANCH_SCOPE = /Scope: the code branch/u;
const FAILED_WIKI_CHECK = /wiki-link:Chats/u;
const OUT_OF_DOCS_FIXES = /after 1 check-fix attempts.*wiki-link:Chats/u;

/**
 * @param {Parameters<typeof fakeContext>[0]} [script]
 */
function mergedContext(script = {}) {
  return fakeContext({
    ...script,
    state: { codeMerged: CODE_MERGED, pr: PR, ...script.state },
    ops: { verify: [VERIFIED], push: [PUSHED], ...script.ops },
  });
}

/**
 * The verified head of wiki-only work in the hardening phase.
 * @param {ReturnType<typeof mergedContext>} run
 */
function verified(run) {
  return verifiedHead(run.ctx, run.ctx.state, {
    mode: { kind: "wiki-only", merged: CODE_MERGED },
    phase: "hardening",
    maxCiFixes: run.ctx.cfg.maxCiFixes,
  });
}

/** @param {Parameters<typeof opNames>[0]} ops */
function codeOpsIn(ops) {
  return opNames(ops).filter((name) => CODE_OPS.has(name));
}

test("the tests run under a temporary pipeline root", () => {
  assert.equal(ROOT, TEMPORARY_ROOT);
  assert.ok(TEMPORARY_ROOT.startsWith(os.tmpdir()));
});

test("the Developer's wiki-only work is scoped to docs/ and pushes the wiki alone", async () => {
  const { ctx, ops, sessions } = mergedContext();
  const end = await implementorRole(ctx);
  assert.deepEqual(opNames(ops), ["push"]);
  assert.deepEqual(ops[0]?.payload, { number: ISSUE, wikiOnly: true });
  assert.equal(sessions.length, 1);
  const task = sessions[0]?.task ?? "";
  assert.match(task, MERGED_PR);
  assert.match(task, DOCS_ONLY);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.equal(end.state.headSha, BRANCH_HEAD);
  assert.deepEqual(end.state.codeMerged, CODE_MERGED);
  assert.equal(end.state.pr, PR);
});

test("wiki-only verification checks exactly the merge commit and the pending wiki", async () => {
  const run = mergedContext();
  const end = await verified(run);
  assert.deepEqual(opNames(run.ops), ["verify", "wiki-check"]);
  assert.deepEqual(run.ops[0]?.payload, {
    number: ISSUE,
    codeMerged: CODE_MERGED,
  });
  assert.deepEqual(end, { ok: true, value: MERGED });
});

test("a verify of anything but the merge commit stops with error", async () => {
  const run = mergedContext({
    ops: { verify: [{ ...VERIFIED, headSha: BASE }] },
  });
  const end = await verified(run);
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "error");
  assert.match(
    end.end.reason,
    new RegExp(`checked ${BASE}, not the merge commit ${MERGED}`, "u"),
  );
  assert.equal(run.sessions.length, 0);
});

test("checks failing on the merged code stop check-fixes with no fix session, naming them", async () => {
  const run = mergedContext({
    ops: { verify: [CODE_FAILS], "wiki-check": [WIKI_FAILS] },
  });
  const end = await verified(run);
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "check-fixes");
  assert.match(
    end.end.reason,
    new RegExp(
      `merged code at ${MERGED}, which wiki-only work can't change: test`,
      "u",
    ),
  );
  assert.equal(run.sessions.length, 0);
  assert.equal(opNames(run.ops).filter((name) => name === "verify").length, 1);
});

test("a failing wiki check gets fix sessions scoped to docs/ only, and every verify stays on the merge commit", async () => {
  const run = mergedContext({
    ops: { "wiki-check": [WIKI_FAILS, WIKI_PASSES] },
  });
  const end = await verified(run);
  assert.equal(run.sessions.length, 1);
  const fix = run.sessions[0]?.task ?? "";
  assert.match(fix, FAILED_WIKI_CHECK);
  assert.match(fix, DOCS_ONLY);
  assert.doesNotMatch(fix, BRANCH_SCOPE);
  const verifies = run.ops.filter((call) => call.name === "verify");
  assert.equal(verifies.length, 2);
  for (const call of verifies) {
    assert.deepEqual(call.payload, { number: ISSUE, codeMerged: CODE_MERGED });
  }
  assert.deepEqual(codeOpsIn(run.ops), []);
  assert.deepEqual(end, { ok: true, value: MERGED });
});

test("a wiki check that keeps failing stops check-fixes after exactly maxCiFixes docs fixes", async () => {
  const run = mergedContext({
    config: { maxCiFixes: 1 },
    ops: { "wiki-check": [WIKI_FAILS] },
  });
  const end = await verified(run);
  assert.equal(run.sessions.length, 1);
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "check-fixes");
  assert.match(end.end.reason, OUT_OF_DOCS_FIXES);
});

test("a wiki-only push that the op refuses propagates its failure", async () => {
  const { OpsFailure } = await import("../src/job/role-context.ts");
  const refused = new OpsFailure(
    "push",
    1,
    "the code checkout's HEAD is not the issue branch's head",
  );
  const { ctx } = mergedContext({ ops: { push: [refused] } });
  await assert.rejects(implementorRole(ctx), refused);
});

test("cannot on wiki-only work stops not-doable before any op", async () => {
  const { ctx, ops } = mergedContext({
    sessions: [{ ok: true, reply: { outcome: "cannot", reason: "no page" } }],
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "not-doable");
  assert.deepEqual(opNames(ops), []);
});
