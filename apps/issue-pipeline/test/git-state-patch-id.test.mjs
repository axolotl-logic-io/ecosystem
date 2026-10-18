// @ts-check
// patchIdOf (#394, review-keeps-on-clean-rebase): the patch id of the changes
// a head makes against its merge base with the base, which a clean rebase
// keeps and any edit to those changes, whitespace included, changes. Run
// against a real git repo.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { setEnv, sh } from "./ops-run-test-kit.mjs";

const d = fs.mkdtempSync("/tmp/issue-pipeline-patch-id-");
process.on("exit", () => fs.rmSync(d, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
setEnv("ISSUE_PIPELINE_ROOT", d);
const { patchIdOf } = await import("../src/git-state.ts");

const REPO = `${d}/repo`;
const BASE = "integration";
const LINES = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
// The line the issue changes, and one far enough away to merge cleanly.
const ISSUE_LINE = 1;
const OTHER_LINE = 6;
const PATCH_ID = /^[0-9a-f]{40}$/u;

// Runs git in the test repo.
/** @param {string} args @returns {string} */
function git(args) {
  return sh(`git -C ${REPO} ${args}`);
}

// Writes `lines` to `file` and commits it on the checked-out branch.
/** @param {string} file @param {string[]} lines @param {string} message @returns {string} */
function commit(file, lines, message) {
  fs.writeFileSync(`${REPO}/${file}`, `${lines.join("\n")}\n`);
  git(`add ${file}`);
  git(`commit -qm "${message}"`);
  return git("rev-parse HEAD");
}

// `LINES` with line `at` (0-based) replaced by `text`.
/** @param {number} at @param {string} text @returns {string[]} */
function withLine(at, text) {
  const lines = [...LINES];
  lines.splice(at, 1, text);
  return lines;
}

// A new branch `name` off the base, which changes the issue's line of f to
// `text`.
/** @param {string} name @param {string} text @returns {string} */
function issueBranch(name, text) {
  git(`checkout -q -b ${name} ${BASE}`);
  return commit("f", withLine(ISSUE_LINE, text), name);
}

// The id the git CLI gives the diff `from`..`head`, or null for no output.
/** @param {string} from @param {string} head @returns {string | null} */
function cliPatchId(from, head) {
  const out = git(`diff --binary ${from} ${head} | git patch-id --verbatim`);
  return out.split(" ")[0] || null;
}

sh(`git init -q -b ${BASE} ${REPO}`);
git("config user.email a@b");
git("config user.name a");
commit("f", LINES, "base");
commit("g", ["other"], "base g");

test("the patch id is git's verbatim id of the head's changes against the base", () => {
  const head = issueBranch("cli", "TWO");
  assert.equal(patchIdOf(REPO, BASE, head), cliPatchId(BASE, head));
  assert.match(String(patchIdOf(REPO, BASE, head)), PATCH_ID);
});

test("a clean rebase onto a base that moved elsewhere keeps the patch id", () => {
  const head = issueBranch("rebase", "TWO");
  const before = patchIdOf(REPO, BASE, head);
  git(`checkout -q ${BASE}`);
  commit("f", withLine(OTHER_LINE, "SEVEN"), "base moves elsewhere in f");
  commit("g", ["moved"], "base moves g");
  git("checkout -q rebase");
  git(`rebase -q ${BASE}`);
  const rebased = git("rev-parse HEAD");
  assert.notEqual(rebased, head);
  assert.equal(patchIdOf(REPO, BASE, rebased), before);
});

test("an edit to the issue's change gives a new patch id", () => {
  const head = issueBranch("edit", "TWO");
  const before = patchIdOf(REPO, BASE, head);
  const edited = commit("f", withLine(ISSUE_LINE, "TWO!"), "edit");
  assert.notEqual(patchIdOf(REPO, BASE, edited), before);
});

test("a whitespace-only edit to the issue's change gives a new patch id", () => {
  const head = issueBranch("space", "TWO");
  const before = patchIdOf(REPO, BASE, head);
  const indented = commit("f", withLine(ISSUE_LINE, "  TWO"), "indent");
  assert.notEqual(patchIdOf(REPO, BASE, indented), before);
});

test("a conflict resolution that changes the issue's hunk gives a new patch id", () => {
  const head = issueBranch("conflict", "TWO");
  const before = patchIdOf(REPO, BASE, head);
  git(`checkout -q ${BASE}`);
  commit("f", withLine(ISSUE_LINE, "Two"), "base edits the same line");
  git("checkout -q conflict");
  sh(`git -C ${REPO} rebase -q ${BASE} >/dev/null 2>&1 || true`);
  fs.writeFileSync(
    `${REPO}/f`,
    `${withLine(ISSUE_LINE, "TWO and Two").join("\n")}\n`,
  );
  git("add f");
  sh(`GIT_EDITOR=true git -C ${REPO} rebase --continue >/dev/null 2>&1`);
  const resolved = git("rev-parse HEAD");
  assert.notEqual(patchIdOf(REPO, BASE, resolved), before);
});

test("a head with no changes against the base has no patch id", () => {
  git(`checkout -q -b empty ${BASE}`);
  git("commit -q --allow-empty -m start");
  assert.equal(patchIdOf(REPO, BASE, git("rev-parse HEAD")), null);
});

test("a head git can't resolve, or one with no merge base, has no patch id", () => {
  assert.equal(patchIdOf(REPO, BASE, "no-such-ref"), null);
  git("checkout -q --orphan unrelated");
  commit("h", ["unrelated"], "unrelated root");
  assert.equal(patchIdOf(REPO, BASE, git("rev-parse HEAD")), null);
});
