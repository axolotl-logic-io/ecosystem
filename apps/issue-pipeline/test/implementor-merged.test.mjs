// @ts-check
// The implementor once the issue's code merged (`state.codeMerged`): only the
// wiki work remains. There is no start-pr, code sync or open-pr; verify runs
// the repo's checks on exactly the merge commit and wiki-check the pending
// wiki; a failure on the merged code stops with check-fixes and no session,
// a wiki failure gets docs-only fix sessions, and the push is the wiki's
// alone, with the merge commit as the verified code.
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import {
  BASE,
  DONE,
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
// The ops a wiki-only run may never make: they touch the code branch or PR.
const CODE_OPS = new Set([
  "start-pr",
  "sync-base",
  "finish-sync",
  "open-pr",
  "close-pr",
]);

const MERGED_PR = /already merged, as PR #12/u;
const DOCS_ONLY_WORK = /change only `docs\/`, and commit nothing in `repo\/`/u;
const FAILED_WIKI_CHECK = /wiki-link:Chats/u;
const DOCS_ONLY_FIX = /fix it in the wiki in `docs\/` only/u;
const BRANCH_FIX_SCOPE = /the code, the tests or the wiki/u;
const OUT_OF_DOCS_FIXES = /after 1 check-fix attempts.*wiki-link:Chats/u;
const WIKI_CONTINUE_COMMAND = /git -C docs rebase --continue/u;

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

/** @param {Parameters<typeof opNames>[0]} ops */
function codeOpsIn(ops) {
  return opNames(ops).filter((name) => CODE_OPS.has(name));
}

test("the tests run under a temporary pipeline root", () => {
  assert.equal(ROOT, TEMPORARY_ROOT);
  assert.ok(TEMPORARY_ROOT.startsWith(os.tmpdir()));
});

test("wiki-only work syncs the wiki, verifies the merge commit and pushes the wiki alone", async () => {
  const { ctx, ops, sessions } = mergedContext();
  const end = await implementorRole(ctx);
  assert.deepEqual(opNames(ops), ["wiki-sync", "verify", "wiki-check", "push"]);
  assert.deepEqual(codeOpsIn(ops), []);
  assert.deepEqual(ops[1]?.payload, {
    number: ISSUE,
    codeMerged: CODE_MERGED,
  });
  assert.deepEqual(ops[2]?.payload, { number: ISSUE });
  assert.deepEqual(ops[3]?.payload, { number: ISSUE, wikiOnly: true });
  assert.equal(sessions.length, 1);
  const task = sessions[0]?.task ?? "";
  assert.match(task, MERGED_PR);
  assert.match(task, DOCS_ONLY_WORK);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.equal(end.state.verifiedSha, MERGED);
  assert.equal(end.state.headSha, BRANCH_HEAD);
  assert.deepEqual(end.state.codeMerged, CODE_MERGED);
  assert.equal(end.state.pr, PR);
  assert.equal(end.state.mergeReturn, null);
});

test("a verify of anything but the merge commit stops with error, pushing nothing", async () => {
  const { ctx, ops, sessions } = mergedContext({
    ops: { verify: [{ ...VERIFIED, headSha: BASE }] },
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "error");
  assert.match(
    end.reason,
    new RegExp(`checked ${BASE}, not the merge commit ${MERGED}`, "u"),
  );
  assert.equal(sessions.length, 1);
  assert.ok(!opNames(ops).includes("push"));
  assert.equal(end.state.verifiedSha, null);
});

test("checks failing on the merged code stop check-fixes with no fix session, naming them", async () => {
  const { ctx, ops, sessions } = mergedContext({
    ops: { verify: [CODE_FAILS], "wiki-check": [WIKI_FAILS] },
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "check-fixes");
  assert.match(
    end.reason,
    new RegExp(
      `merged code at ${MERGED}, which wiki-only work can't change: test`,
      "u",
    ),
  );
  assert.equal(sessions.length, 1);
  assert.equal(opNames(ops).filter((name) => name === "verify").length, 1);
  assert.ok(!opNames(ops).includes("push"));
});

test("a failing wiki check gets fix sessions scoped to docs/ only, and every verify stays on the merge commit", async () => {
  const { ctx, ops, sessions } = mergedContext({
    ops: { "wiki-check": [WIKI_FAILS, WIKI_PASSES] },
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 2);
  const fix = sessions[1]?.task ?? "";
  assert.match(fix, FAILED_WIKI_CHECK);
  assert.match(fix, DOCS_ONLY_FIX);
  assert.doesNotMatch(fix, BRANCH_FIX_SCOPE);
  const verifies = ops.filter((call) => call.name === "verify");
  assert.equal(verifies.length, 2);
  for (const call of verifies) {
    assert.deepEqual(call.payload, { number: ISSUE, codeMerged: CODE_MERGED });
  }
  assert.deepEqual(codeOpsIn(ops), []);
  assert.ok(end.kind === "next");
  assert.equal(end.state.verifiedSha, MERGED);
  assert.equal(opNames(ops).at(-1), "push");
});

test("a wiki check that keeps failing stops check-fixes after exactly maxCiFixes docs fixes", async () => {
  const { ctx, ops, sessions } = mergedContext({
    config: { maxCiFixes: 1 },
    ops: { "wiki-check": [WIKI_FAILS] },
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 2);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "check-fixes");
  assert.match(end.reason, OUT_OF_DOCS_FIXES);
  assert.ok(!opNames(ops).includes("push"));
});

test("a wiki conflict is resolved before the work, with no code sync", async () => {
  const { ctx, ops, sessions } = mergedContext({
    ops: {
      "wiki-sync": [
        {
          changed: false,
          conflict: true,
          inRebase: true,
          conflicts: ["Chats.md"],
          baseSha: BASE,
        },
      ],
    },
    sessions: [
      {
        ok: true,
        reply: { outcome: "conflict-resolved", summary: "kept both" },
      },
      DONE,
    ],
  });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 2);
  assert.match(sessions[0]?.task ?? "", WIKI_CONTINUE_COMMAND);
  assert.deepEqual(codeOpsIn(ops), []);
  assert.ok(opNames(ops).includes("finish-wiki-sync"));
  assert.ok(end.kind === "next");
  assert.equal(end.state.counts.conflictFixes, 1);
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

test("cannot on wiki-only work stops not-doable", async () => {
  const { ctx, ops } = mergedContext({
    sessions: [{ ok: true, reply: { outcome: "cannot", reason: "no page" } }],
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "not-doable");
  assert.deepEqual(opNames(ops), ["wiki-sync"]);
});
