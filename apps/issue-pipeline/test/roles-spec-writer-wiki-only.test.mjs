// @ts-check
// The spec writer's wiki-only path on the runner with its real checks (#334,
// #391): the reply's `wikiOnly` tells a spec whose wiki pages are the whole
// change from a `noTestsReason` code change, which lists no files. A
// wiki-only spec opens no PR, closes an earlier one and saves at review; a
// `noTestsReason` spec that isn't wiki-only opens a PR and saves at
// implement, whether or not it edits the wiki; and a wiki-only reply that
// changed no wiki page has nothing to build. Every run is made before the
// tests, because the fake gh's writes are global.
import assert from "node:assert/strict";
import { test } from "node:test";
import { specWriter } from "./spec-writer-git-test-kit.mjs";
import { replyOf } from "./spec-writer-role-test-kit.mjs";
import { PR, specPosts } from "./spec-writer-run-test-kit.mjs";

/** @typedef {Awaited<ReturnType<typeof specWriter>>} Ran */

const WIKI = { "Quota.md": "Quota.\n", "Home.md": "base\nSee [[Quota]].\n" };
const EARLIER_PR = 41;
const REASON = "Every test would pin the wording, not a promise.";
const NO_TESTS = { interfaces: [], noTestsReason: REASON };
const WIKI_ONLY = replyOf({ ...NO_TESTS, wikiOnly: true });
const CODE_CHANGE = replyOf({ ...NO_TESTS, wikiOnly: false });
const FAILED_TWICE = "the spec writer failed twice";
const NOTHING_TO_BUILD = "nothing to build";

/** @param {readonly string[][]} writes @returns {number} the draft PRs opened */
function prsOpened(writes) {
  return writes.filter(([cmd, sub]) => cmd === "pr" && sub === "create").length;
}

/** @param {Ran} ran @returns {string[][]} the PRs it closed */
function closes(ran) {
  return ran.writes.filter(([cmd, sub]) => cmd === "pr" && sub === "close");
}

const wikiOnly = await specWriter({
  replies: [WIKI_ONLY],
  wiki: WIKI,
  start: { pr: EARLIER_PR },
});
const codeWithWiki = await specWriter({ replies: [CODE_CHANGE], wiki: WIKI });
// No wikiOnly at all reads as a code change.
const codeUnsaid = await specWriter({ replies: [replyOf(NO_TESTS)] });
const wikiOnlyEmpty = await specWriter({ replies: [WIKI_ONLY] });

test("a wiki-only spec closes the earlier PR and saves at review, with no files", () => {
  assert.deepEqual(wikiOnly.end, { kind: "saved", stage: "review" });
  assert.deepEqual(closes(wikiOnly), [["pr", "close", String(EARLIER_PR)]]);
  assert.equal(prsOpened(wikiOnly.writes), 0);
  assert.equal(specPosts(wikiOnly.writes), 1);
  assert.equal(Object.hasOwn(wikiOnly.saved, "files"), false);
});

test("a noTestsReason spec that edits the wiki but isn't wiki-only opens a PR and saves at implement", () => {
  assert.deepEqual(codeWithWiki.end, { kind: "saved", stage: "implement" });
  assert.equal(codeWithWiki.saved.pr, PR);
  assert.equal(prsOpened(codeWithWiki.writes), 1);
  assert.deepEqual(closes(codeWithWiki), []);
  assert.equal(Object.hasOwn(codeWithWiki.saved, "files"), false);
});

test("a noTestsReason spec with nothing committed and no wikiOnly opens a PR and saves at implement", () => {
  assert.deepEqual(codeUnsaid.end, { kind: "saved", stage: "implement" });
  assert.equal(codeUnsaid.saved.pr, PR);
  assert.equal(prsOpened(codeUnsaid.writes), 1);
});

test("a wiki-only reply that changed no wiki page fails nothing-to-build, and twice stops the issue", () => {
  const { end, tasks } = wikiOnlyEmpty;
  const { stopReason } = wikiOnlyEmpty.saved;
  assert.deepEqual(end, { kind: "stopped", code: "error" });
  assert.equal(stopReason, FAILED_TWICE);
  assert.equal(tasks.length, 2);
  assert.ok(String(tasks[1]).includes(NOTHING_TO_BUILD), tasks[1]);
  assert.equal(specPosts(wikiOnlyEmpty.writes), 0);
  assert.equal(prsOpened(wikiOnlyEmpty.writes), 0);
});
