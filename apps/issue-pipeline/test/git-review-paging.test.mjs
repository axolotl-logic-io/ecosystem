// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  coveredLines,
  delivery,
  eachAsync,
  fixture,
  git,
  pageLines,
  query,
  readAll,
} from "./git-review-test-kit.mjs";

const { MAX_RESULT_BYTES, reviewer } = await import("../src/job/git-review.ts");
const MAX_PAGE_LINES = 1000;
const TOTAL_LINES = 6000;
const ADDITIONS = 5995;
const OVERSIZED_LIMIT = 100_000;
const LONG_LINE_BYTES = 60_000;
const WIDE_LINE_BYTES = 5000;
const WIDE_LINE_COUNT = 20;
const TOO_WIDE = /cannot fit intact/u;
const END = "=== END ===";

/** @import { Delivery } from '../src/job/git-review.ts' */

test("delivers all 6000 real diff lines within line and serialized byte limits", async () => {
  const { repo, tool } = fixture();
  fs.writeFileSync(
    path.join(repo, "empty.txt"),
    `${Array.from(
      { length: ADDITIONS },
      (_, index) =>
        `line ${index} with enough text to exercise byte limited pages`,
    ).join("\n")}\n`,
  );
  const argv = ["diff", "-U0", "--", "empty.txt"];
  const expected = git(repo, [
    "--no-pager",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "-U0",
    "--",
    "empty.txt",
  ])
    .trimEnd()
    .split("\n");
  assert.equal(expected.length, TOTAL_LINES);
  /** @type {Delivery[]} */
  const records = [];
  /** @type {string[]} */
  const lines = [];
  let offset = 1;
  const pages = await readAll(tool, repo, argv, OVERSIZED_LIMIT);
  for (const result of pages) {
    const record = delivery(result);
    records.push(record);
    assert.equal(record.totalLines, TOTAL_LINES);
    assert.equal(record.startLine, offset);
    assert.ok(record.endLine !== null);
    const served = pageLines(result);
    assert.equal(served.length, record.endLine - offset + 1);
    assert.ok(served.length <= MAX_PAGE_LINES);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES);
    assert.equal(
      result.content[0]?.text.endsWith(END),
      record.endLine === TOTAL_LINES,
    );
    lines.push(...served);
    offset = record.endLine + 1;
  }
  assert.deepEqual(lines, expected);
  const [first] = records;
  assert.ok(first);
  assert.equal(coveredLines(records, first).size, TOTAL_LINES);
});

test("empty output has END and null ranges, never invented covered lines", async () => {
  const { repo, tool } = fixture();
  const result = await query(tool, repo, ["diff"]);
  const record = delivery(result);
  assert.equal(record.totalLines, 0);
  assert.equal(record.startLine, null);
  assert.equal(record.endLine, null);
  assert.deepEqual(pageLines(result), []);
  assert.ok(result.content[0]?.text.endsWith(END));
  assert.equal(coveredLines([record], record).size, 0);
});

test("pages stay stable across mutations but not across queries, repos or sessions", async () => {
  const { repo, tool } = fixture();
  fs.writeFileSync(path.join(repo, "file.txt"), "original\n");
  const first = await query(tool, repo, ["diff"], { limit: 1 });
  const firstRecord = delivery(first);
  fs.writeFileSync(path.join(repo, "file.txt"), "different\nextra\n");
  assert.deepEqual(await query(tool, repo, ["diff"], { limit: 1 }), first);
  const full = await query(tool, repo, ["diff"], { limit: OVERSIZED_LIMIT });
  assert.equal(delivery(full).queryId, firstRecord.queryId);
  assert.ok(pageLines(full).includes("+original"));
  assert.ok(!pageLines(full).includes("+different"));
  const changed = await query(tool, repo, ["diff", "--no-color"]);
  assert.notEqual(delivery(changed).queryId, firstRecord.queryId);
  assert.ok(pageLines(changed).includes("+different"));
  const another = fixture();
  const multi = reviewer(JSON.stringify([repo, another.repo]));
  const sameRepo = delivery(await query(multi, repo, ["diff"]));
  const otherRepo = delivery(await query(multi, another.repo, ["diff"]));
  assert.notEqual(otherRepo.queryId, sameRepo.queryId);
  assert.notEqual(otherRepo.repository, sameRepo.repository);
  const fresh = await query(reviewer(JSON.stringify([repo])), repo, ["diff"]);
  assert.notEqual(delivery(fresh).sessionId, firstRecord.sessionId);
  assert.notEqual(delivery(fresh).queryId, firstRecord.queryId);
  assert.ok(pageLines(fresh).includes("+different"));
  assert.equal(coveredLines([delivery(fresh), otherRepo], firstRecord).size, 0);
});

test("accounts for JSON escaping, metadata and END in the byte cap", async () => {
  const { repo, tool } = fixture();
  const line = '"\\'.repeat(WIDE_LINE_BYTES);
  fs.writeFileSync(
    path.join(repo, "file.txt"),
    `${Array.from({ length: WIDE_LINE_COUNT }, () => line).join("\n")}\n`,
  );
  git(repo, ["add", "."]);
  const result = await query(tool, repo, ["show", "HEAD:file.txt"]);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES);
  const staged = await query(tool, repo, ["cat-file", "-p", ":file.txt"]);
  assert.equal(staged.isError, true);
  git(repo, ["commit", "-qm", "wide"]);
  const wide = await query(tool, repo, ["cat-file", "-p", "HEAD:file.txt"], {
    limit: OVERSIZED_LIMIT,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) <= MAX_RESULT_BYTES);
  const record = delivery(wide);
  assert.equal(record.totalLines, WIDE_LINE_COUNT);
  assert.ok(record.endLine !== null && record.endLine < WIDE_LINE_COUNT);
  assert.equal(pageLines(wide)[0], line);
  assert.ok(!wide.content[0]?.text.endsWith(END));
});

test("a line too large to deliver causes an explicit error and no served range", async () => {
  const { repo, tool } = fixture();
  fs.writeFileSync(
    path.join(repo, "file.txt"),
    `small\n${"x".repeat(LONG_LINE_BYTES)}\nlast\n`,
  );
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "oversized"]);
  const argv = ["cat-file", "-p", "HEAD:file.txt"];
  const first = delivery(
    await query(tool, repo, argv, { limit: OVERSIZED_LIMIT }),
  );
  assert.equal(first.startLine, 1);
  assert.equal(first.endLine, 1);
  const failed = await query(tool, repo, argv, { offset: 2 });
  assert.equal(failed.isError, true);
  assert.ok("error" in failed.details);
  assert.match(failed.content[0]?.text ?? "", TOO_WIDE);
  const last = delivery(await query(tool, repo, argv, { offset: 3 }));
  assert.equal(coveredLines([first, last], first).size, 2);
  assert.equal(coveredLines([first, last], first).has(2), false);
});

test("failed Git and invalid page requests never acquire coverage", async () => {
  const { repo, tool } = fixture();
  await eachAsync(
    [
      { cwd: repo, argv: ["show", "missing-ref"] },
      { cwd: repo, argv: ["log"], offset: 0 },
      { cwd: repo, argv: ["log"], limit: -1 },
      { cwd: repo, argv: ["log"], offset: OVERSIZED_LIMIT },
      { cwd: repo, argv: ["log"], extra: "unsupported" },
    ],
    async (params) => {
      const result = await tool.execute("call", params);
      assert.equal(result.isError, true);
      assert.ok("error" in result.details);
    },
  );
});

test("coverage requires a union for one query, not repeats, other queries or END alone", async () => {
  const { repo, tool } = fixture();
  const argv = ["cat-file", "-p", "HEAD:file.txt"];
  const first = delivery(await query(tool, repo, argv, { limit: 1 }));
  const repeat = delivery(await query(tool, repo, argv, { limit: 1 }));
  const lastResult = await query(tool, repo, argv, { offset: 2, limit: 1 });
  const last = delivery(lastResult);
  assert.deepEqual(repeat, first);
  assert.ok(lastResult.content[0]?.text.endsWith(END));
  assert.equal(coveredLines([last], first).has(1), false);
  assert.equal(coveredLines([first, repeat], first).size, 1);
  assert.equal(
    coveredLines([first, repeat, last], first).size,
    first.totalLines,
  );
  const foreign = delivery(
    await query(tool, repo, ["show", "HEAD:file.txt"], {
      limit: OVERSIZED_LIMIT,
    }),
  );
  assert.equal(coveredLines([last, foreign], first).has(1), false);
});

test("blank lines, a UTF-8 BOM and an unterminated final line survive paging", async () => {
  const { repo, tool } = fixture();
  fs.writeFileSync(path.join(repo, "file.txt"), "\uFEFFfirst\n\n終");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "unicode"]);
  const pages = await readAll(
    tool,
    repo,
    ["cat-file", "-p", "HEAD:file.txt"],
    1,
  );
  const expected = ["\uFEFFfirst", "", "終"];
  assert.deepEqual(pages.flatMap(pageLines), expected);
  for (const result of pages) {
    assert.equal(delivery(result).totalLines, expected.length);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES);
  }
});

test("non-UTF-8 evidence fails explicitly rather than silently replacing bytes", async () => {
  const { repo, tool } = fixture();
  const invalidUtf8Byte = 255;
  fs.writeFileSync(path.join(repo, "file.txt"), Buffer.from([invalidUtf8Byte]));
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "non unicode"]);
  const result = await query(tool, repo, ["cat-file", "-p", "HEAD:file.txt"]);
  assert.equal(result.isError, true);
  assert.ok("error" in result.details);
  assert.ok(result.content[0]?.text.includes("not UTF-8"));
});
