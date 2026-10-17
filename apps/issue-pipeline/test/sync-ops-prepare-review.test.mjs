// @ts-check
// prepare-review: its reply and the review diff it writes, run through the ops
// CLI against a local origin. It never calls gh. Split from sync-ops.test.mjs,
// which no longer fit in 300 lines.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { okLine, opsFixture } from "./ops-fixture.mjs";

const fx = await opsFixture("sync-ops-prepare-review");
const { fakeGh, sh, worktree } = fx;
const BASE = "origin/integration";
const WIKI_HEADING =
  "\n\n# Wiki changes (paths under wiki/; pushed to the wiki when the PR merges)\n\n";
// Each test's issue.
const ISSUE = {
  mergeBase: 21,
  sinceSha: 22,
  rebasedSince: 23,
  wiki: 24,
  prereq: 25,
  stacked: 26,
};
// The reply fields the stacked test reads.
const REVIEW_REPLY = z.looseObject({
  baseSha: z.string(),
  diffPath: z.string(),
  changedFiles: z.array(z.string()),
});

// Runs an op; returns its stdout and the gh calls it made.
/** @param {object} request @param {string} [config] @returns {{ out: string, calls: string[][] }} */
function ask(request, config) {
  fakeGh.reply([]);
  const out = fx.ask(request, config);
  return { out, calls: fakeGh.calls() };
}

/** @param {string} dir @param {string} args @returns {string} */
function gitIn(dir, args) {
  return sh(`git -C ${dir} ${args}`);
}

// A diff exactly as git prints it, untrimmed.
/** @param {string} dir @param {string} range @returns {string} */
function patch(dir, range) {
  const args = ["-C", dir, "diff", "--stat", "--patch", range];
  return spawnSync("git", args, { encoding: "utf8" }).stdout;
}

/** @typedef {{ file: string, reply: { headSha: string, headTree: string, baseSha: string, diffPath: string, diffLines: number, changedFiles: string[] } }} Review */

// What prepare-review should reply and write for the diff `from..HEAD`.
/** @param {number} n @param {string | undefined} from @param {string} tag @param {{ diff: string, files: string[] }} [wiki] @returns {Review} */
function review(n, from, tag, wiki = { diff: "", files: [] }) {
  const wt = worktree(n);
  const headSha = gitIn(wt, "rev-parse HEAD");
  const headTree = gitIn(wt, `rev-parse ${headSha}^{tree}`);
  const baseSha = gitIn(wt, `merge-base ${BASE} HEAD`);
  const code = patch(wt, `${from ?? baseSha}..${headSha}`);
  let file = code;
  if (wiki.diff !== "") {
    file = `${code}${WIKI_HEADING}${wiki.diff}`;
  }
  const names = gitIn(wt, `diff --name-only ${baseSha}..${headSha}`);
  const diffPath = path.join(
    fx.root,
    "runs",
    "o__r",
    `issue-${n}`,
    `review-${tag}`,
    "diff.patch",
  );
  const changedFiles = names.split("\n").concat(wiki.files);
  const diffLines = file.split("\n").length;
  return {
    file,
    reply: { headSha, headTree, baseSha, diffPath, diffLines, changedFiles },
  };
}

// What prepare-review replied and wrote, beside what it should have. The
// replies are compared as objects, since nothing promises their key order.
/** @param {string} out @param {Review} want @returns {{ got: { reply: unknown, file: string }, expected: { reply: unknown, file: string } }} */
function reviewOutcome(out, want) {
  const file = fs.readFileSync(want.reply.diffPath, "utf8");
  const expected = JSON.parse(okLine("prepare-review", want.reply));
  return {
    got: { reply: JSON.parse(out), file },
    expected: { reply: expected, file: want.file },
  };
}

test("prepare-review diffs the branch from its merge base", () => {
  fx.startBranch(ISSUE.mergeBase, "g", "one");
  fx.commitIn(ISSUE.mergeBase, "h", "two");
  fx.advanceBase("b21", "base");
  const { out, calls } = ask({ op: "prepare-review", number: ISSUE.mergeBase });
  assert.deepEqual(calls, []);
  const want = review(ISSUE.mergeBase, undefined, "r0");
  assert.deepEqual(want.reply.changedFiles, ["g", "h"]);
  const { got, expected } = reviewOutcome(out, want);
  assert.deepEqual(got, expected);
});

test("prepare-review diffs from sinceSha while it is in the branch", () => {
  const n = ISSUE.sinceSha;
  const since = fx.startBranch(n, "g", "one");
  fx.commitIn(n, "h", "two");
  const { out, calls } = ask({
    op: "prepare-review",
    number: n,
    sinceSha: since,
    tag: "r2",
  });
  assert.deepEqual(calls, []);
  const want = review(n, since, "r2");
  assert.ok(want.file.includes("+two"));
  assert.ok(!want.file.includes("+one"));
  const { got, expected } = reviewOutcome(out, want);
  assert.deepEqual(got, expected);
});

test("prepare-review falls back to the merge base when sinceSha was rebased away", () => {
  const n = ISSUE.rebasedSince;
  fx.startBranch(n, "g", "one");
  const since = fx.commitIn(n, "h", "two");
  gitIn(worktree(n), "commit -q --amend -m reworded");
  const { out, calls } = ask({
    op: "prepare-review",
    number: n,
    sinceSha: since,
  });
  assert.deepEqual(calls, []);
  const { got, expected } = reviewOutcome(out, review(n, undefined, "r0"));
  assert.deepEqual(got, expected);
});

test("prepare-review appends the issue's wiki commits", () => {
  const wikiOrigin = path.join(fx.root, "wiki.git");
  const seed = path.join(fx.root, "wiki-seed");
  sh(
    `git init -q --bare -b master ${wikiOrigin} && git clone -q ${wikiOrigin} ${seed} 2>/dev/null`,
  );
  sh(`cd ${seed} && git config user.email a@b && git config user.name a`);
  sh(
    `cd ${seed} && echo home > Home.md && git add . && git commit -qm home && git push -q origin HEAD:master`,
  );
  const config = fx.configWith("wiki-config.json", {
    wiki: { url: wikiOrigin },
  });
  fx.startBranch(ISSUE.wiki, "g", "one");
  const wiki = path.join(worktree(ISSUE.wiki), "wiki");
  sh(
    `git clone -q ${wikiOrigin} ${wiki} && cd ${wiki} && git config user.email a@b && git config user.name a`,
  );
  sh(`cd ${wiki} && echo page > Page.md && git add . && git commit -qm page`);
  const { out, calls } = ask(
    { op: "prepare-review", number: ISSUE.wiki },
    config,
  );
  assert.deepEqual(calls, []);
  const diff = patch(wiki, "origin/master...HEAD");
  const want = review(ISSUE.wiki, undefined, "r0", {
    diff,
    files: ["wiki/Page.md"],
  });
  assert.deepEqual(want.reply.changedFiles, ["g", "wiki/Page.md"]);
  const { got, expected } = reviewOutcome(out, want);
  assert.deepEqual(got, expected);
});

test("prepare-review of a stacked branch diffs only its own change, from the prerequisite's head", () => {
  const prereqHead = fx.startBranch(ISSUE.prereq, "prereq-file", "prereq");
  const wt = worktree(ISSUE.stacked);
  sh(
    `git -C ${fx.root}/clones/o__r worktree add -q -B agent/issue-${ISSUE.stacked} ${wt} ${prereqHead}`,
  );
  fx.commitIn(ISSUE.stacked, "own-file", "own");
  const stackedOn = { issue: ISSUE.prereq, headSha: prereqHead };
  const request = { op: "prepare-review", number: ISSUE.stacked, stackedOn };
  const reply = REVIEW_REPLY.parse(JSON.parse(ask(request).out));
  assert.equal(reply.baseSha, prereqHead);
  assert.deepEqual(reply.changedFiles, ["own-file"]);
  const diff = fs.readFileSync(reply.diffPath, "utf8");
  assert.ok(diff.includes("own-file"));
  assert.ok(!diff.includes("prereq-file"));
});
