// @ts-check
// The finalizer role's wiki steps (#416), as today's merge stage takes them
// (src/workflow/stages/merge-wiki.ts, sync-conflict.ts): with a wiki
// checkout, the wiki is rebased and checked before the code merges; a
// conflict goes to the conflict resolver, a writer session, then the rebase
// is finished; and the resolver's outcomes, attempts and continuations.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIXED,
  finalize,
  MERGED_LABEL,
  opsSent,
  prMerges,
  resolverReply,
  sentTo,
} from "./finalizer-role-test-kit.mjs";

const WRITER = "issue-pipeline-writer";
const CHECK_FAILED = {
  pass: false,
  checks: [
    { id: "links", pass: false, detail: "Home.md links a missing page" },
  ],
};
const CANNOT_FIX = resolverReply("cannot-fix", "Both sides rewrote Home.md.");
const HANDED_OFF = resolverReply("handoff", "Half the pages are done.");
const REJECTED = { resolved: false, reason: "conflict markers remain" };
// The default cap on conflict resolutions (maxConflictFixes).
const MAX_CONFLICT_FIXES = 2;
// The conflict resolver's timeout, as the sweep gives it.
const RESOLVER_MINUTES = 45;
/** @import { Outcome } from "../src/job/run-step.ts" */

// A resolver session that fails on a model provider's rate limit.
/** @type {Outcome} */
const RATE_LIMITED = {
  ok: false,
  error:
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"cooling down"}}',
};

/** @param {readonly string[]} ops @param {string} first @param {string} then */
function before(ops, first, then) {
  const at = ops.indexOf(first);
  return at !== -1 && at < ops.indexOf(then);
}

test("with a wiki, the wiki is rebased and checked before the code merges", async () => {
  const run = await finalize({ wiki: true });
  assert.deepEqual(run.end, { kind: "saved", stage: "done" });
  const ops = opsSent(run);
  assert.ok(before(ops, "wiki-sync", "wiki-check"), ops.join(", "));
  assert.ok(before(ops, "wiki-check", "merge"), ops.join(", "));
  assert.deepEqual(run.sessions, []);
  assert.equal(prMerges(run.writes), 1);
});

test("without a wiki checkout, no wiki step runs before the merge", async () => {
  const run = await finalize();
  assert.deepEqual(run.end, { kind: "saved", stage: "done" });
  assert.deepEqual(sentTo(run, "wiki-sync"), []);
  assert.deepEqual(sentTo(run, "wiki-check"), []);
});

test("wiki pages that fail the wiki check stop the issue before the merge", async () => {
  const run = await finalize({ wiki: true, wikiCheck: CHECK_FAILED });
  assert.deepEqual(run.end, { kind: "stopped", code: "wiki-check" });
  assert.deepEqual(sentTo(run, "merge"), []);
  assert.deepEqual(run.labels, ["agent:stopped-wiki-check"]);
});

test("a wiki conflict runs the resolver as a writer, finishes the rebase, then merges", async () => {
  const run = await finalize({ wiki: true, wikiConflict: true });
  assert.deepEqual(run.end, { kind: "saved", stage: "done" });
  const [session, ...more] = run.sessions;
  assert.deepEqual(more, []);
  assert.equal(session?.agent, WRITER);
  assert.equal(session?.writer, true);
  assert.equal(session?.minutes, RESOLVER_MINUTES);
  const [finish = {}] = sentTo(run, "finish-wiki-sync");
  const { abort } = finish;
  assert.equal(abort, false);
  const ops = opsSent(run);
  assert.ok(before(ops, "finish-wiki-sync", "merge"), ops.join(", "));
  assert.equal(prMerges(run.writes), 1);
  assert.deepEqual(run.labels, [MERGED_LABEL]);
  const { conflictFixes } = run.saved;
  assert.equal(conflictFixes, 1);
});

test("a wiki conflict past maxConflictFixes stops the issue with no resolver", async () => {
  const run = await finalize({
    wiki: true,
    wikiConflict: true,
    start: { conflictFixes: MAX_CONFLICT_FIXES },
  });
  assert.deepEqual(run.end, { kind: "stopped", code: "conflict" });
  assert.deepEqual(run.sessions, []);
  assert.deepEqual(sentTo(run, "merge"), []);
  assert.deepEqual(run.labels, ["agent:stopped-conflict"]);
});

test("a resolver that can't fix the conflict aborts the rebase and holds the issue at merge", async () => {
  const run = await finalize({
    wiki: true,
    wikiConflict: true,
    resolvers: [CANNOT_FIX],
  });
  assert.deepEqual(run.end, { kind: "held" });
  const [finish = {}] = sentTo(run, "finish-wiki-sync");
  const { abort } = finish;
  assert.equal(abort, true);
  assert.deepEqual(sentTo(run, "merge"), []);
  const { stage, conflictFixes } = run.saved;
  assert.equal(stage, "merge");
  assert.equal(conflictFixes, 1);
  assert.deepEqual(run.labels, []);
});

test("a rejected resolution holds the issue at merge while attempts remain", async () => {
  const run = await finalize({
    wiki: true,
    wikiConflict: true,
    finishWikiSync: REJECTED,
  });
  assert.deepEqual(run.end, { kind: "held" });
  assert.deepEqual(sentTo(run, "merge"), []);
  const { stage } = run.saved;
  assert.equal(stage, "merge");
});

test("a rejected resolution on the last attempt stops the issue", async () => {
  const run = await finalize({
    wiki: true,
    wikiConflict: true,
    finishWikiSync: REJECTED,
    start: { conflictFixes: MAX_CONFLICT_FIXES - 1 },
  });
  assert.deepEqual(run.end, { kind: "stopped", code: "conflict" });
  assert.deepEqual(sentTo(run, "merge"), []);
  assert.deepEqual(run.labels, ["agent:stopped-conflict"]);
});

test("a resolver that hands off gets a continuation on the same rebase, then the merge", async () => {
  const run = await finalize({
    wiki: true,
    wikiConflict: true,
    resolvers: [HANDED_OFF, FIXED],
  });
  assert.deepEqual(run.end, { kind: "saved", stage: "done" });
  assert.equal(run.sessions.length, 2);
  assert.equal(sentTo(run, "finish-wiki-sync").length, 1);
  const { conflictFixes } = run.saved;
  assert.equal(conflictFixes, 1);
  assert.equal(prMerges(run.writes), 1);
});

test("a resolver that hits a rate limit aborts the rebase and holds the issue, counting no attempt", async () => {
  const run = await finalize({
    wiki: true,
    wikiConflict: true,
    resolvers: [RATE_LIMITED],
    start: { conflictFixes: MAX_CONFLICT_FIXES - 1 },
  });
  assert.deepEqual(run.end, { kind: "held", rateLimited: true });
  const [finish = {}] = sentTo(run, "finish-wiki-sync");
  const { abort } = finish;
  assert.equal(abort, true);
  assert.deepEqual(sentTo(run, "merge"), []);
  const { stage, conflictFixes, lease } = run.saved;
  assert.equal(stage, "merge");
  assert.equal(conflictFixes, MAX_CONFLICT_FIXES - 1);
  assert.equal(lease, null);
  assert.deepEqual(run.labels, []);
});

test("a rate-limited continuation gives back the attempt and its continuation", async () => {
  const run = await finalize({
    wiki: true,
    wikiConflict: true,
    resolvers: [HANDED_OFF, RATE_LIMITED],
  });
  assert.deepEqual(run.end, { kind: "held", rateLimited: true });
  assert.equal(run.sessions.length, 2);
  const { conflictFixes, continuations } = run.saved;
  assert.equal(conflictFixes, 0);
  assert.deepEqual(continuations, {});
});

test("a resolver that hands off with no continuation left stops the issue as too large", async () => {
  const run = await finalize({
    wiki: true,
    wikiConflict: true,
    resolvers: [HANDED_OFF],
    cfg: { maxContinuations: 0 },
  });
  assert.deepEqual(run.end, { kind: "stopped", code: "too-large" });
  assert.deepEqual(sentTo(run, "merge"), []);
  assert.deepEqual(run.labels, ["agent:stopped-too-large"]);
});
