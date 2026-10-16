// @ts-check
// The merge stage's wiki steps (src/workflow/stages/merge-wiki.ts), driven
// directly with recorded replies (#216): with a wiki, merge rebases the
// issue's wiki commits onto the wiki's latest version and checks them before
// the code merges, the conflict resolver settles a wiki conflict, and a merge
// whose wiki changes were not published moves to the publish stage.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/merge.ts";
import {
  CTX,
  replied,
  STAMP,
  sessionEnded,
  stateWith,
} from "./workflow-finish-test-kit.mjs";

/** @import { OpResult, StageState, Step } from "../src/workflow/stages/types.ts" */

const WIKI = "/w/issue-7/wiki";
const CLEAN = { ok: true, conflict: false, changed: false, headSha: "" };
const CONFLICT = {
  ok: true,
  conflict: true,
  inRebase: true,
  conflicts: ["Home.md"],
  baseSha: "abcdefabcdefabcdef",
  branch: "master",
};
const PASSED = { ok: true, pass: true, checks: [] };
const WIKI_REBASE =
  /in the wiki checkout \/w\/issue-7\/wiki, onto the wiki's origin\/master \(abcdefabcdef\)/u;
const TYPE_CHECK = /type check/u;
const FIXED = { status: "fixed", summary: "Kept both paragraphs." };

/** @param {Partial<StageState["st"]>} [fields] @returns {StageState} */
function wikiMerge(fields = {}) {
  const given = stateWith("merge", { acceptReason: "Does it.", ...fields });
  return { ...given, paths: { ...given.paths, wiki: WIKI } };
}

/** @param {Step} step @returns {string[]} */
function opsOf(step) {
  if (step.done) {
    return [];
  }
  return step.launches.map((launch) => launch.name);
}

// The step after the wiki-sync answered `reply`.
/** @param {OpResult["reply"]} reply @param {Partial<StageState["st"]>} [fields] @returns {Step} */
function synced(reply, fields = {}) {
  return replied(next, next(wikiMerge(fields), CTX, []), reply);
}

// The step after the resolver fixed a conflict and finish-wiki-sync answered `reply`.
/** @param {OpResult["reply"]} reply @returns {Step} */
function finishedWith(reply) {
  const resolving = synced(CONFLICT, { testsOnly: true });
  const ended = sessionEnded(next, resolving, {
    ok: true,
    structuredOutput: FIXED,
  });
  return replied(next, ended, reply);
}

test("with a wiki, merge rebases the wiki, checks it, then merges", () => {
  const begun = next(wikiMerge(), CTX, []);
  assert.deepEqual(opsOf(begun), ["wiki-sync"]);
  const checking = replied(next, begun, CLEAN);
  assert.deepEqual(opsOf(checking), ["wiki-check"]);
  assert.deepEqual(opsOf(replied(next, checking, PASSED)), ["merge"]);
});

test("without a wiki, merge asks for the merge at once", () => {
  assert.deepEqual(opsOf(next(stateWith("merge"), CTX, [])), ["merge"]);
});

test("a wiki that fails its check stops the issue before the merge", () => {
  const checks = [
    {
      id: "wiki-link:Home.md:Gone",
      pass: false,
      detail: "Home.md links to Gone",
    },
  ];
  const checking = synced(CLEAN);
  const step = replied(next, checking, { ok: true, pass: false, checks });
  assert.equal(step.done, true);
  assert.deepEqual(step.stop, {
    reason: "the wiki changes failed the wiki check",
    detail: "- Home.md links to Gone",
    code: "wiki-check",
  });
});

test("a wiki conflict goes to the resolver in the wiki checkout", () => {
  const step = synced(CONFLICT, { testsOnly: true, passedSha: "p" });
  assert.equal(step.done, false);
  const [launch] = step.launches;
  assert.ok(launch.kind === "child");
  assert.equal(launch.agent, "issue-pipeline-writer");
  assert.match(launch.task, WIKI_REBASE);
  assert.doesNotMatch(launch.task, TYPE_CHECK);
  assert.equal(step.stop, null);
  assert.deepEqual(
    [
      step.state.st.conflictFixes,
      step.state.st.testsOnly,
      step.state.st.passedSha,
    ],
    [1, true, "p"],
  );
});

test("a resolved wiki conflict goes on to the wiki check, counting no sync", () => {
  const resolving = synced(CONFLICT);
  const ended = sessionEnded(next, resolving, {
    ok: true,
    structuredOutput: FIXED,
  });
  assert.deepEqual(opsOf(ended), ["finish-wiki-sync"]);
  const step = finishedWith({ ok: true, resolved: true, headSha: "beef" });
  assert.deepEqual(opsOf(step), ["wiki-check"]);
  assert.equal(step.state.st.syncs, undefined);
  assert.equal(step.state.st.testsOnly, true);
  assert.equal(
    step.state.st.log?.at(-1),
    `${STAMP} resolved the wiki's conflicts with the wiki's master`,
  );
  assert.deepEqual(
    step.comments.map((comment) => [comment.by.role, comment.body]),
    [["conflict resolver (attempt 1)", "Kept both paragraphs."]],
  );
});

test("a rejected wiki resolution stays at merge for the next sweep", () => {
  const step = finishedWith({
    ok: true,
    resolved: false,
    reason: "still conflicted",
  });
  assert.deepEqual(
    [step.done, step.stop, step.state.st.stage],
    [true, null, "merge"],
  );
});

test("a wiki conflict after the last resolution stops as a conflict", () => {
  const step = synced(CONFLICT, { conflictFixes: 2 });
  assert.deepEqual(step.stop, {
    reason: "rebasing the wiki onto master conflicts again after 2 resolutions",
    detail: "Conflicting files:\nHome.md",
    code: null,
  });
});

test("a merge whose wiki changes were not published moves to publish", () => {
  const merging = replied(next, synced(CLEAN), PASSED);
  const step = replied(next, merging, {
    ok: true,
    merged: true,
    published: false,
  });
  assert.deepEqual(
    [
      step.done && step.again,
      step.state.closed,
      step.state.st.stage,
      step.stop,
    ],
    [true, false, "publish", null],
  );
  const closed = replied(next, merging, {
    ok: true,
    merged: true,
    published: true,
  });
  assert.deepEqual(
    [closed.done && closed.again, closed.state.closed, closed.state.outcome],
    [false, true, "merged"],
  );
});
