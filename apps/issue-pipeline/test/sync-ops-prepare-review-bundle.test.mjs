// @ts-check
// prepare-review's review bundle (#415): bundle.md beside diff.patch, holding
// the diff as diff.patch has it, then the head text of each changed file in
// path order, up to the size bound, with past-bound, deleted and binary files
// listed by path only. Run through the ops CLI against a local origin, as
// sync-ops-prepare-review.test.mjs runs the rest of the reply.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { opsFixture } from "./ops-fixture.mjs";

const fx = await opsFixture("sync-ops-prepare-review-bundle");
const { fakeGh, sh, worktree } = fx;
// Imported after the fixture, which must set the pipeline root first.
const { REVIEW_BUNDLE_MAX_CHARS } = await import(
  "../src/workflow/stages/review-prefix.ts"
);
const BASE = "integration";
// Each test's issue.
const ISSUE = { order: 41, again: 42, bound: 43, pathOnly: 44, wiki: 45 };
// The reply fields these tests read; the bundle's are checked by value.
const BUNDLE_REPLY = z.looseObject({
  ok: z.literal(true),
  diffPath: z.string(),
  bundlePath: z.string().optional(),
  bundleLines: z.unknown().optional(),
  bundleText: z.unknown().optional(),
});

// A file git counts as binary, since it holds NUL bytes.
const BINARY = Buffer.from("\u0089PNG\u0000\u0000binary-415\n", "latin1");

/** @typedef {{ diffPath: string, bundlePath?: string | undefined, bundleLines?: unknown, bundleText?: unknown }} BundleReply */
/** @typedef {{ reply: BundleReply, diff: string, bundle: string }} Prepared */

// prepare-review for issue `n` with `config`: its reply, the diff it wrote and
// the bundle it wrote, or "" when it named none.
/** @param {number} n @param {string} [config] @returns {Prepared} */
function prepare(n, config) {
  fakeGh.reply([]);
  const out = fx.ask({ op: "prepare-review", number: n }, config);
  const reply = BUNDLE_REPLY.parse(JSON.parse(out));
  let bundle = "";
  if (reply.bundlePath !== undefined) {
    bundle = fs.readFileSync(reply.bundlePath, "utf8");
  }
  return { reply, diff: fs.readFileSync(reply.diffPath, "utf8"), bundle };
}

// The bundle's part after the diff, or "" when it doesn't start with the diff.
/** @param {Prepared} prepared @returns {string} */
function filesPart({ diff, bundle }) {
  if (!bundle.startsWith(diff)) {
    return "";
  }
  return bundle.slice(diff.length);
}

// Issue `n`'s file at its head: the worktree is clean at its head.
/** @param {number} n @param {string} file @returns {string} */
function headText(n, file) {
  return fs.readFileSync(path.join(worktree(n), file), "utf8");
}

// Commits `content` as `file` in issue `n`'s worktree, as it is, untrimmed.
/** @param {number} n @param {string} file @param {string | Buffer} content @returns {void} */
function commitRaw(n, file, content) {
  fs.writeFileSync(path.join(worktree(n), file), content);
  sh(`cd ${worktree(n)} && git add ${file} && git commit -qm "edit ${file}"`);
}

// Commits `content` as `file` on the base branch, through the seed clone.
/** @param {string} file @param {string} content @returns {void} */
function commitOnBase(file, content) {
  const seed = path.join(fx.root, "seed");
  sh(`cd ${seed} && git checkout -q ${BASE} && git pull -q origin ${BASE}`);
  fs.writeFileSync(path.join(seed, file), content);
  sh(
    `cd ${seed} && git add ${file} && git commit -qm "base ${file}" && git push -q origin HEAD:${BASE}`,
  );
}

// A text longer than the bundle's size bound, whose last line is `last`.
/** @param {string} last @returns {string} */
function pastTheBound(last) {
  const line = "row-415 of a file too long for the bundle\n";
  const rows = Math.ceil(REVIEW_BUNDLE_MAX_CHARS / line.length) + 1;
  return `${line.repeat(rows)}${last}\n`;
}

test("prepare-review writes bundle.md beside the diff: the commits and the diff as diff.patch has them, then each changed file's head text in path order", () => {
  const n = ISSUE.order;
  fx.startBranch(n, "b-file", "bravo-415");
  fx.commitIn(n, "a-file", "alpha-415\nsecond line", "add the alpha file");
  const prepared = prepare(n);
  const { reply, diff, bundle } = prepared;
  const dir = path.dirname(reply.diffPath);
  assert.equal(reply.bundlePath, path.join(dir, "bundle.md"));
  assert.ok(diff.includes("add the alpha file"));
  assert.ok(bundle.startsWith(diff), "the bundle doesn't start with the diff");
  const files = filesPart(prepared);
  const alpha = files.indexOf(headText(n, "a-file"));
  const bravo = files.indexOf(headText(n, "b-file"));
  assert.ok(alpha >= 0, `a-file's head text missing from:\n${files}`);
  assert.ok(bravo >= 0, `b-file's head text missing from:\n${files}`);
  assert.ok(alpha < bravo, "the files are not in path order");
  assert.equal(reply.bundleLines, bundle.split("\n").length);
  assert.equal(reply.bundleText, bundle, "the reply holds the bundle's text");
});

test("a second prepare-review at the same head writes the same bundle, byte for byte", () => {
  const n = ISSUE.again;
  fx.startBranch(n, "g", "one");
  fx.commitIn(n, "h", "two", "second commit");
  const first = prepare(n).reply.bundlePath;
  assert.ok(first !== undefined, "prepare-review named no bundle");
  const bytes = fs.readFileSync(first);
  fs.rmSync(first);
  const second = prepare(n);
  assert.equal(second.reply.bundlePath, first);
  assert.ok(fs.readFileSync(first).equals(bytes));
  assert.equal(second.reply.bundleLines, second.bundle.split("\n").length);
});

test("past the size bound, a changed file and every file after it in path order are listed by path only", () => {
  const n = ISSUE.bound;
  commitOnBase("big-file", pastTheBound("row-415 the last row"));
  fx.startBranch(n, "a-small", "alpha-small-415");
  const big = headText(n, "big-file");
  commitRaw(n, "big-file", `first row edited\n${big}`);
  fx.commitIn(n, "c-small", "gamma-small-415");
  const files = filesPart(prepare(n));
  assert.ok(files.includes(headText(n, "a-small")));
  for (const listed of ["big-file", "c-small"]) {
    assert.ok(files.includes(listed), `${listed} not listed in:\n${files}`);
  }
  assert.ok(!files.includes("row-415 the last row"), "big-file's text is in");
  assert.ok(!files.includes("gamma-small-415"), "c-small's text is in");
});

test("a deleted file and a binary file are listed by path only", () => {
  const n = ISSUE.pathOnly;
  fx.advanceBase("gone-file", "doomed-415");
  fx.startBranch(n, "kept-file", "kept-415");
  sh(`cd ${worktree(n)} && git rm -q gone-file && git commit -qm "drop it"`);
  commitRaw(n, "pic.bin", BINARY);
  const files = filesPart(prepare(n));
  assert.ok(files.includes(headText(n, "kept-file")));
  for (const listed of ["gone-file", "pic.bin"]) {
    assert.ok(files.includes(listed), `${listed} not listed in:\n${files}`);
  }
  assert.ok(!files.includes("doomed-415"), "the deleted file's text is in");
  assert.ok(!files.includes("\u0000"), "the binary file's bytes are in");
});

test("the bundle holds the issue's wiki commits as diff.patch has them, and reads no wiki page from the code checkout", () => {
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
  fx.startBranch(ISSUE.wiki, "g", "code-415");
  const wiki = path.join(worktree(ISSUE.wiki), "wiki");
  sh(
    `git clone -q ${wikiOrigin} ${wiki} && cd ${wiki} && git config user.email a@b && git config user.name a`,
  );
  sh(`cd ${wiki} && echo page-415 > Page.md && git add . && git commit -qm p`);
  const prepared = prepare(ISSUE.wiki, config);
  assert.ok(prepared.diff.includes("+page-415"));
  const files = filesPart(prepared);
  assert.ok(files.includes(headText(ISSUE.wiki, "g")));
});
