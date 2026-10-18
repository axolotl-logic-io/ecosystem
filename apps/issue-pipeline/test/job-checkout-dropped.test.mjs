// @ts-check
// A job's dropped changes are saved as patches (dropped-changes-saved, #369):
// closing a job's checkouts writes what each left uncommitted to
// dropped/<job key>-<checkout>.patch in the issue's run folder, which
// `git apply --index` restores on the base commit, before it drops it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  configIn,
  git,
  headOf,
  ISSUE,
  root,
  write,
} from "./pipeline-commit-test-kit.mjs";

const { paths } = await import("../src/config.ts");
const { closeJobCheckout, openJobCheckout } = await import(
  "../src/job/checkout.ts"
);

/** @import { Config } from "../src/config.ts" */

const KEY = "implement-1";
const LATER_KEY = "implement-2";
const BASE_LINE = /^Base: (?<sha>[0-9a-f]{40})$/mu;
const EXIT_STEP_FAILED = /job: exit: /u;
const FIRST_FILE = /first\.txt/u;
const SECOND_FILE = /second\.txt/u;
// Every byte value, so the patch must carry a binary file whole.
const BINARY = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));
// Text that isn't UTF-8: a Latin-1 é is the lone byte 0xe9.
const LATIN1 = Buffer.from("café\n", "latin1");
// The files each checkout is left holding besides its tracked file.
const LEFT = ["new.txt", "notes.txt", "blob.bin", "latin1.txt"];

/** @typedef {{ cfg: Config, root: string, repo: string, docs: string, origin: string, wikiOrigin: string }} Opened */

/** @param {Config} cfg @param {string} tmp @returns {Opened} */
function openIn(cfg, tmp) {
  const job = { stage: "implement", stackOn: null };
  const dirs = openJobCheckout(cfg, ISSUE, job);
  if (dirs.docs === null) {
    throw new Error("the job has no wiki checkout");
  }
  return {
    cfg,
    root: dirs.root,
    repo: dirs.repo,
    docs: dirs.docs,
    origin: path.join(tmp, "origin.git"),
    wikiOrigin: path.join(tmp, "wiki-origin.git"),
  };
}

/** @returns {Opened} a fresh implement job's checkouts for #7 */
function openFresh() {
  const tmp = fs.mkdtempSync(path.join(root, "dropped-"));
  return openIn(configIn(tmp), tmp);
}

/** @param {Opened} job @param {string} key */
async function close(job, key) {
  const { cfg, repo, docs } = job;
  const dirs = { root: job.root, repo, docs, key };
  return await closeJobCheckout(cfg, ISSUE, { ...dirs, wiki: "write" }, null);
}

/**
 * Leaves every kind of uncommitted change in `dir`, whose tracked file is
 * `tracked`, and an ignored file; returns each changed file's bytes.
 * @param {string} dir
 * @param {string} tracked
 * @returns {Map<string, Buffer>}
 */
function leaveChanges(dir, tracked) {
  write(dir, tracked, "staged\n");
  git(dir, ["add", tracked]);
  write(dir, tracked, "staged\nunstaged\n");
  write(dir, "new.txt", "staged new\n");
  git(dir, ["add", "new.txt"]);
  write(dir, "notes.txt", "untracked\n");
  fs.writeFileSync(path.join(dir, "blob.bin"), BINARY);
  fs.writeFileSync(path.join(dir, "latin1.txt"), LATIN1);
  const exclude = git(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  fs.appendFileSync(exclude, "ignored.txt\n");
  write(dir, "ignored.txt", "ignored\n");
  const files = new Map();
  for (const file of [tracked, ...LEFT]) {
    files.set(file, fs.readFileSync(path.join(dir, file)));
  }
  return files;
}

/**
 * A fresh clone of `origin` at `sha` with `patch` applied by
 * `git apply --index`.
 * @param {string} origin
 * @param {string} sha
 * @param {string} patch
 * @returns {string}
 */
function restored(origin, sha, patch) {
  const fresh = fs.mkdtempSync(path.join(root, "fresh-"));
  execFileSync("git", ["clone", "--quiet", origin, fresh]);
  git(fresh, ["checkout", "--quiet", sha]);
  git(fresh, ["apply", "--index", patch]);
  return fresh;
}

/** @param {Config} cfg @param {string} relative @returns {string} */
function inRunDir(cfg, relative) {
  return path.join(paths.runDir(cfg, ISSUE), relative);
}

/** @param {string} prefix @param {Map<string, Buffer>} files @returns {string[]} */
function under(prefix, files) {
  return [...files.keys()].map((file) => `${prefix}/${file}`);
}

test("each checkout's staged, unstaged and untracked changes are saved as a patch that restores them on the base commit", async () => {
  const job = openFresh();
  const bases = { repo: headOf(job.repo), docs: headOf(job.docs) };
  const left = {
    repo: leaveChanges(job.repo, "README.md"),
    docs: leaveChanges(job.docs, "Home.md"),
  };
  const { lost, patches } = await close(job, KEY);
  assert.deepEqual(patches, [
    `dropped/${KEY}-repo.patch`,
    `dropped/${KEY}-docs.patch`,
  ]);
  const expected = [...under("repo", left.repo), ...under("docs", left.docs)];
  assert.deepEqual([...lost].sort(), expected.sort());
  const origins = { repo: job.origin, docs: job.wikiOrigin };
  for (const name of /** @type {const} */ (["repo", "docs"])) {
    const patch = inRunDir(job.cfg, `dropped/${KEY}-${name}.patch`);
    const text = fs.readFileSync(patch, "latin1");
    const title = `Dropped changes of issue #${ISSUE}, job ${KEY}, checkout ${name}/`;
    assert.equal(text.split("\n")[0], title);
    const { sha } = BASE_LINE.exec(text)?.groups ?? {};
    assert.equal(sha, bases[name], name);
    const fresh = restored(origins[name], bases[name], patch);
    for (const [file, bytes] of left[name]) {
      assert.deepEqual(fs.readFileSync(path.join(fresh, file)), bytes, file);
    }
    assert.equal(fs.existsSync(path.join(fresh, "ignored.txt")), false);
  }
  assert.equal(fs.existsSync(job.root), false);
});

test("clean checkouts write no patch and no dropped folder", async () => {
  const job = openFresh();
  const { lost, patches } = await close(job, KEY);
  assert.deepEqual(lost, []);
  assert.deepEqual(patches, []);
  assert.equal(fs.existsSync(inRunDir(job.cfg, "dropped")), false);
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

test("a patch that can't be saved is reported, and the changes are still dropped and the folder removed", async () => {
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
  let closed;
  try {
    closed = await close(job, KEY);
  } finally {
    process.stderr.write = writeErr;
  }
  assert.match(errors.join(""), EXIT_STEP_FAILED);
  assert.deepEqual(closed.lost, ["repo/left.txt"]);
  assert.deepEqual(closed.patches, []);
  assert.equal(fs.existsSync(job.root), false);
});
