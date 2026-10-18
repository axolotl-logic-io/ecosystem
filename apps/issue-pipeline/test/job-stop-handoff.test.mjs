// @ts-check
// The job's save for a writer it stopped at the hard context limit
// (wrap-up-at-175k, kill-saves-writer-work): on every stop it commits the
// session's uncommitted work as a WIP commit where that is safe, keeps a
// handoff the session wrote, adding a note on that work, keeps an earlier
// round's handoff the session left unchanged, adding its own section below
// it, and writes the whole handoff when there is none.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { saveStoppedWork } from "../src/job/stop-handoff.ts";

const PAST_HARD = 2100;
const BRANCH = "agent/issue-7";
const KEY = "i7-implement-1";
const LONG_TEXT_CHARS = 5000;
const KEPT_TEXT_CHARS = 2000;
const OWN = "## Done\nThe parser.\n";
const EARLIER = "# Earlier\n\nThe parser is done; its tests are left.\n";
const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
];

/** @param {string} dir @param {readonly string[]} args @returns {string} */
function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...IDENTITY, ...args], {
    encoding: "utf8",
  }).trim();
}

/** @typedef {{ dir: string, handoffFile: string, head: string }} Repo */

/** @returns {Repo} a repo on the issue's branch with one commit */
function repo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-wrap-"));
  process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, "work");
  fs.mkdirSync(dir);
  git(dir, ["init", "--quiet", "-b", BRANCH]);
  git(dir, ["config", "user.name", "Job"]);
  git(dir, ["config", "user.email", "job@example.com"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "--quiet", "-m", "base"]);
  const head = git(dir, ["rev-parse", "HEAD"]);
  return { dir, handoffFile: path.join(tmp, "handoff.md"), head };
}

// The job's save for a writer in `at` stopped at hard, whose handoff file
// held `handoff` as it started.
/** @param {Repo} at @param {string | null} handoff */
function stopIn(at, handoff) {
  const place = { repo: at.dir, handoffFile: at.handoffFile };
  return saveStoppedWork(place, {
    key: KEY,
    stop: { context: PAST_HARD },
    lastText: "x".repeat(LONG_TEXT_CHARS),
    start: { head: at.head, handoff },
  });
}

/** @param {string} file @returns {string} */
function read(file) {
  return fs.readFileSync(file, "utf8");
}

/** @returns {Repo} a repo mid-rebase with an uncommitted edit to a.txt */
function rebasingRepo() {
  const at = repo();
  fs.writeFileSync(path.join(at.dir, "a.txt"), "edited\n");
  fs.mkdirSync(path.join(at.dir, ".git", "rebase-merge"));
  return at;
}

/** @returns {Repo} a repo whose commit hooks refuse, with b.txt untracked */
function hookedRepo() {
  const at = repo();
  fs.writeFileSync(path.join(at.dir, "b.txt"), "new\n");
  const hook = path.join(at.dir, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return at;
}

test("a stopped writer's own handoff is kept", () => {
  const clean = repo();
  fs.writeFileSync(clean.handoffFile, OWN);
  stopIn(clean, null);
  assert.equal(read(clean.handoffFile), OWN);
  const edited = repo();
  fs.writeFileSync(path.join(edited.dir, "a.txt"), "edited\n");
  fs.writeFileSync(edited.handoffFile, OWN);
  const { wipCommit } = stopIn(edited, null);
  assert.ok(wipCommit !== null);
  const subject = git(edited.dir, ["log", "-1", "--format=%s"]);
  assert.ok(subject.startsWith("WIP:"), subject);
  assert.equal(git(edited.dir, ["status", "--short"]), "");
  const handoff = read(edited.handoffFile);
  assert.ok(handoff.startsWith(OWN), handoff);
  assert.ok(handoff.includes(wipCommit), handoff);
});

test("a continuation's stop keeps the earlier handoff and adds the job's section, with the last text cut to 2000 characters", () => {
  const at = repo();
  fs.writeFileSync(at.handoffFile, EARLIER);
  stopIn(at, EARLIER);
  const handoff = read(at.handoffFile);
  assert.ok(handoff.startsWith(EARLIER), handoff);
  const after = handoff.slice(EARLIER.length).split("\n");
  const section = after.find((line) => line.startsWith("## "));
  assert.ok(section?.includes(KEY), handoff);
  assert.equal(
    after.some((line) => line.startsWith("# ")),
    false,
    handoff,
  );
  assert.ok(handoff.includes("x".repeat(KEPT_TEXT_CHARS)), handoff);
  assert.equal(handoff.includes("x".repeat(KEPT_TEXT_CHARS + 1)), false);
});

test("no WIP commit mid-rebase, or when the commit hooks refuse it; the handoff says why", () => {
  const rebasing = rebasingRepo();
  assert.equal(stopIn(rebasing, null).wipCommit, null);
  assert.ok(read(rebasing.handoffFile).includes("rebase-merge"));
  assert.equal(git(rebasing.dir, ["log", "--format=%s"]), "base");
  const hooked = hookedRepo();
  assert.equal(stopIn(hooked, null).wipCommit, null);
  assert.ok(read(hooked.handoffFile).includes("hooks"));
  assert.equal(git(hooked.dir, ["status", "--short"]), "?? b.txt");
});

test("with its own handoff, no WIP commit mid-rebase or when the hooks refuse it; the reason is appended", () => {
  const rebasing = rebasingRepo();
  fs.writeFileSync(rebasing.handoffFile, OWN);
  assert.equal(stopIn(rebasing, null).wipCommit, null);
  const rebasingHandoff = read(rebasing.handoffFile);
  assert.ok(rebasingHandoff.startsWith(OWN), rebasingHandoff);
  assert.ok(
    rebasingHandoff.slice(OWN.length).includes("rebase-merge"),
    rebasingHandoff,
  );
  assert.equal(git(rebasing.dir, ["log", "--format=%s"]), "base");
  const hooked = hookedRepo();
  fs.writeFileSync(hooked.handoffFile, OWN);
  assert.equal(stopIn(hooked, null).wipCommit, null);
  const hookedHandoff = read(hooked.handoffFile);
  assert.ok(hookedHandoff.startsWith(OWN), hookedHandoff);
  assert.ok(hookedHandoff.slice(OWN.length).includes("hooks"), hookedHandoff);
  assert.equal(git(hooked.dir, ["status", "--short"]), "?? b.txt");
});
