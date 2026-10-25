// prepare-review's review bundle (#415): bundle.md beside diff.patch, holding
// the diff as diff.patch has it, then the head text of each changed file in
// path order, up to the size bound, with past-bound, deleted and binary files
// listed by path only. Run through the ops CLI against a local origin, as
// sync-ops-prepare-review.test.ts runs the rest of the reply.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { OpsFixture } from "../ops-fixtures.ts";
import { opsFixture } from "../ops-fixtures.ts";

const fx: OpsFixture = await opsFixture("sync-ops-prepare-review-bundle");
const { fakeGh, sh, worktree }: OpsFixture = fx;
// The review bundle's cap on its inline diff, loaded once the fixture has
// isolated the root.
const {
  REVIEW_BUNDLE_MAX_CHARS,
}: typeof import("../../src/ops/review-diff.ts") = await import(
  "../../src/ops/review-diff.ts"
);
const BASE = "integration";
// Each test's issue.
const ISSUE = {
  order: 41,
  again: 42,
  bound: 43,
  pathOnly: 44,
  docs: 45,
};
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

interface BundleReply {
  diffPath: string;
  bundlePath?: string | undefined;
  bundleLines?: unknown;
  bundleText?: unknown;
}
interface Prepared {
  reply: BundleReply;
  diff: string;
  bundle: string;
}

// prepare-review for issue `n`: its reply, the diff it wrote and the bundle
// it wrote, or "" when it named none.
function prepare(n: number): Prepared {
  fakeGh.reply([]);
  const out = fx.ask({ op: "prepare-review", number: n });
  const reply = BUNDLE_REPLY.parse(JSON.parse(out));
  let bundle = "";
  if (reply.bundlePath !== undefined) {
    bundle = fs.readFileSync(reply.bundlePath, "utf8");
  }
  return { reply, diff: fs.readFileSync(reply.diffPath, "utf8"), bundle };
}

// The bundle's part after the diff, or "" when it doesn't start with the diff.
function filesPart({ diff, bundle }: Prepared): string {
  if (!bundle.startsWith(diff)) {
    return "";
  }
  return bundle.slice(diff.length);
}

// Issue `n`'s file at its head: the worktree is clean at its head.
function headText(n: number, file: string): string {
  return fs.readFileSync(path.join(worktree(n), file), "utf8");
}

// Commits `content` as `file` in issue `n`'s worktree, as it is, untrimmed.
function commitRaw(n: number, file: string, content: string | Buffer): void {
  fs.writeFileSync(path.join(worktree(n), file), content);
  sh(`cd ${worktree(n)} && git add ${file} && git commit -qm "edit ${file}"`);
}

// Commits `content` as `file` on the base branch, through the seed clone.
function commitOnBase(file: string, content: string): void {
  const seed = path.join(fx.root, "seed");
  sh(`cd ${seed} && git checkout -q ${BASE} && git pull -q origin ${BASE}`);
  fs.writeFileSync(path.join(seed, file), content);
  sh(
    `cd ${seed} && git add ${file} && git commit -qm "base ${file}" && git push -q origin HEAD:${BASE}`,
  );
}

// A text longer than the bundle's size bound, whose last line is `last`.
function pastTheBound(last: string): string {
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

test("the bundle holds a docs/ page's head text like any code file", () => {
  const n = ISSUE.docs;
  fx.startBranch(n, "g", "code-415");
  fs.mkdirSync(path.join(worktree(n), "docs"));
  fx.commitIn(n, "docs/Page.md", "page-415");
  const prepared = prepare(n);
  assert.ok(prepared.diff.includes("+page-415"));
  const files = filesPart(prepared);
  assert.ok(files.includes(headText(n, "g")));
  assert.ok(files.includes("\n## docs/Page.md\n"), files);
  assert.ok(files.includes(headText(n, "docs/Page.md")));
});
