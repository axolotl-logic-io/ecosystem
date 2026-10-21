// @ts-check
// Committed-brain provenance, independent of prompt delivery and validation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";
import { commitBrain, headsWithGit, writeBrain } from "./brain-test-kit.mjs";
import { AUTHOR_SESSION, READER_STAGE, repliesAt } from "./job-fixtures.mjs";
import { setUp } from "./job-test-kit.mjs";

const { openBrain } = await import("../src/job/brain.ts");
const COMMIT_ID = /^[0-9a-f]{40}$/u;
const SHA1_HEX_LENGTH = 40;
const SHA256_HEX_LENGTH = 64;
const GIT_OPTIONS = { timeout: 30_000 };

function place() {
  return setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
}

test("a brain that is its own git checkout records its HEAD; a folder inside one records none", () => {
  const at = place();
  const head = commitBrain(at.brain);
  assert.match(head, COMMIT_ID);
  assert.deepEqual(
    openBrain(at.brain, "merge").pinned.map((pinned) => pinned.head),
    [head, head],
  );
  // Root identity is canonical even when the caller reaches it via a link.
  const alias = path.join(at.tmp, "brain-link");
  fs.symlinkSync(at.brain, alias, "dir");
  assert.deepEqual(
    openBrain(alias, "merge").pinned.map((pinned) => pinned.head),
    [head, head],
  );
  const inner = writeBrain(path.join(at.brain, "inner"));
  assert.deepEqual(
    openBrain(inner, "merge").pinned.map((pinned) => pinned.head),
    [null, null],
  );
});

test("a brain outside a checkout or with no committed HEAD pins pages with null heads", () => {
  const at = place();
  assert.deepEqual(
    openBrain(at.brain, "merge").pinned.map((pinned) => pinned.head),
    [null, null],
  );
  execFileSync("git", ["init", "-q", at.brain], GIT_OPTIONS);
  assert.deepEqual(
    openBrain(at.brain, "merge").pinned.map((pinned) => pinned.head),
    [null, null],
  );
});

test("Git reporting the top level without a HEAD line pins null, not an empty head", () => {
  const at = place();
  execFileSync("git", ["init", "-q", at.brain], GIT_OPTIONS);
  assert.equal(headsWithGit(at, ""), "[null,null]\n");
});

test("Git root and HEAD reads are independent and every page records the valid full commit", () => {
  const at = place();
  execFileSync("git", ["init", "-q", at.brain], GIT_OPTIONS);
  const head = "a".repeat(SHA1_HEX_LENGTH);
  assert.equal(
    headsWithGit(at, `${head}\n`),
    `${JSON.stringify([head, head])}\n`,
  );
});

test("a valid HEAD cannot supply provenance when the root query fails or identifies another directory", () => {
  const at = place();
  const top = fs.realpathSync(at.brain);
  const head = `${"a".repeat(SHA1_HEX_LENGTH)}\n`;
  for (const root of [
    { stdout: `${top}\n`, code: 1 },
    { stdout: `${path.dirname(top)}\n`, code: 0 },
    { stdout: "", code: 0 },
    { stdout: `${top}\n${top}\n`, code: 0 },
  ]) {
    assert.equal(
      headsWithGit({ ...at, rootRead: root }, head),
      "[null,null]\n",
    );
  }
});

test("unavailable or malformed HEAD output pins every page with a null head", () => {
  const at = place();
  execFileSync("git", ["init", "-q", at.brain], GIT_OPTIONS);
  for (const { name, head, code } of [
    {
      name: "failed HEAD read",
      head: `${"a".repeat(SHA1_HEX_LENGTH)}\n`,
      code: 1,
    },
    { name: "whitespace HEAD", head: " \t\n", code: 0 },
    { name: "short HEAD", head: "abc123\n", code: 0 },
    {
      name: "uppercase HEAD",
      head: `${"A".repeat(SHA1_HEX_LENGTH)}\n`,
      code: 0,
    },
    { name: "non-hex HEAD", head: `${"g".repeat(SHA1_HEX_LENGTH)}\n`, code: 0 },
    {
      name: "SHA-256 HEAD",
      head: `${"a".repeat(SHA256_HEX_LENGTH)}\n`,
      code: 0,
    },
    {
      name: "multiple HEAD lines",
      head: `${"a".repeat(SHA1_HEX_LENGTH)}\n${"b".repeat(SHA1_HEX_LENGTH)}\n`,
      code: 0,
    },
  ]) {
    assert.equal(headsWithGit(at, head, code), "[null,null]\n", name);
  }
});
