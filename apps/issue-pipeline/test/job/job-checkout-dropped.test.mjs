// @ts-check
// Recovery through the real job teardown, with an isolated local Git origin.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  close,
  inRunDir,
  KEY,
  leaveChanges,
  openFresh,
  openIn,
  REGULAR_EXECUTABLE_MODE,
  restored,
  under,
} from "../job-checkout-dropped-test-kit.mjs";
import { headOf, ISSUE, write } from "../pipeline-commit-test-kit.mjs";

const { paths } = await import("../../src/config.ts");

const LATER_KEY = "implement-2";
const BASE_LINE = /^Base: (?<sha>[0-9a-f]{40})$/mu;
const RECOVERY_RETAINED = /recovery incomplete; checkout retained/u;
const FIRST_FILE = /first\.txt/u;
const SECOND_FILE = /second\.txt/u;

/** @param {string} a @param {string} b @returns {number} */
function byName(a, b) {
  return a.localeCompare(b);
}

test("the checkout's staged, unstaged and untracked changes, in its docs/ too, are saved as a patch that restores them on the base commit", async () => {
  const job = openFresh();
  const base = headOf(job.repo);
  const left = leaveChanges(job.repo, "README.md");
  write(job.repo, "docs/Home.md", "docs left\n");
  left.set(
    "docs/Home.md",
    fs.readFileSync(path.join(job.repo, "docs/Home.md")),
  );
  const { lost, patches } = await close(job, KEY);
  assert.deepEqual(patches, [
    `dropped/${KEY}-repo.patch.index.patch`,
    `dropped/${KEY}-repo.patch`,
  ]);
  assert.deepEqual([...lost].sort(byName), under("repo", left).sort(byName));
  const patch = inRunDir(job.cfg, `dropped/${KEY}-repo.patch`);
  const text = fs.readFileSync(patch, "latin1");
  const title = `Dropped changes of issue #${ISSUE}, job ${KEY}, checkout repo/`;
  assert.equal(text.split("\n")[0], title);
  const { sha } = BASE_LINE.exec(text)?.groups ?? {};
  assert.equal(sha, base);
  const fresh = restored(job.origin, base, patch);
  for (const [file, bytes] of left) {
    assert.deepEqual(fs.readFileSync(path.join(fresh, file)), bytes, file);
  }
  assert.equal(
    fs.statSync(path.join(fresh, "run.sh")).mode,
    REGULAR_EXECUTABLE_MODE,
  );
  assert.equal(fs.existsSync(path.join(fresh, "ignored.txt")), false);
  assert.equal(fs.existsSync(job.root), false);
});

test("a clean checkout writes no patch and no dropped folder", async () => {
  const job = openFresh();
  const { lost, patches } = await close(job, KEY);
  assert.deepEqual(lost, []);
  assert.deepEqual(patches, []);
  assert.equal(fs.existsSync(inRunDir(job.cfg, "dropped")), false);
  assert.equal(fs.existsSync(inRunDir(job.cfg, "recovery")), false);
});

test("a later job of the same stage saves its patch beside the earlier one's", async () => {
  const job = openFresh();
  write(job.repo, "first.txt", "first\n");
  await close(job, KEY);
  const later = openIn(job.cfg, path.dirname(job.origin));
  write(later.repo, "second.txt", "second\n");
  const { patches } = await close(later, LATER_KEY);
  assert.deepEqual(patches, [`dropped/${LATER_KEY}-repo.patch`]);
  const earlier = inRunDir(job.cfg, `dropped/${KEY}-repo.patch`);
  assert.match(fs.readFileSync(earlier, "utf8"), FIRST_FILE);
  const next = inRunDir(job.cfg, `dropped/${LATER_KEY}-repo.patch`);
  assert.match(fs.readFileSync(next, "utf8"), SECOND_FILE);
});

test("a failed patch save retains the checkout and original dirty content for operator recovery", async () => {
  const job = openFresh();
  write(job.repo, "left.txt", "left\n");
  const runDir = paths.runDir(job.cfg, ISSUE);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "dropped"), "not a folder\n");
  /** @type {string[]} */
  const errors = [];
  const writeErr = process.stderr.write;
  process.stderr.write = (chunk) => {
    errors.push(String(chunk));
    return true;
  };
  try {
    await assert.rejects(close(job, KEY));
  } finally {
    process.stderr.write = writeErr;
  }
  assert.match(errors.join(""), RECOVERY_RETAINED);
  assert.equal(fs.existsSync(job.root), true);
  assert.equal(
    fs.readFileSync(path.join(job.repo, "left.txt"), "utf8"),
    "left\n",
  );
});
