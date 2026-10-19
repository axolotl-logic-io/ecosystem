// @ts-check
// prepare-review must never treat mode 160000 as a blob, on either side
// of the range, including the actual merged first-parent Security range.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  baseGitlink,
  mergeBranch,
  NEW_COMMIT,
  OLD_COMMIT,
  pendingWiki,
  prepare,
  setGitlink,
  startBranch,
} from "./gitlink-review-test-kit.mjs";
import { isolatedOpsFixture } from "./integration-source-test-kit.mjs";

const fx = await isolatedOpsFixture("review-gitlink");
const { REVIEW_BUNDLE_MAX_CHARS } = await import("../src/ops/review-diff.ts");
const { sh, worktree } = fx;
const FIRST_ISSUE = 101;
const OLD_SIDE = `commit \`${OLD_COMMIT}\``;
const NEW_SIDE = `commit \`${NEW_COMMIT}\``;
const CHANGES = [
  {
    change: "adds",
    before: null,
    after: NEW_COMMIT,
    oldSide: "absent",
    newSide: NEW_SIDE,
  },
  {
    change: "updates",
    before: OLD_COMMIT,
    after: NEW_COMMIT,
    oldSide: OLD_SIDE,
    newSide: NEW_SIDE,
  },
  {
    change: "removes",
    before: OLD_COMMIT,
    after: null,
    oldSide: OLD_SIDE,
    newSide: "absent",
  },
];
const HEADING = /\n## (?<path>[^\n]+)\n/gu;
const TEXT = "full head text\n```\nfenced payload\n````\nlast line\n";

/** @param {number} n @returns {string} */
function commitIndex(n) {
  sh(`git -C ${worktree(n)} commit -qm 'change gitlinks'`);
  return sh(`git -C ${worktree(n)} rev-parse HEAD`);
}

/** @param {string} file @param {string} oldSide @param {string} newSide @returns {string} */
function gitlinkEntry(file, oldSide, newSide) {
  return `\n## ${file}\n\nGitlink: path only. Old: ${oldSide}; new: ${newSide}.\n`;
}

for (const [reviewIndex, merged] of [false, true].entries()) {
  for (const [index, change] of CHANGES.entries()) {
    test(`prepare-review ${change.change} a gitlink for merged Security = ${merged}`, () => {
      const n = FIRST_ISSUE + reviewIndex * CHANGES.length + index;
      baseGitlink(fx, change.before);
      startBranch(fx, n, "marker", `case ${n}`);
      setGitlink(fx, worktree(n), "wiki", change.after);
      const featureHead = commitIndex(n);
      let result = null;
      if (merged) {
        result = mergeBranch(fx, n);
      }
      const { diff, files, reply } = prepare(fx, n, result);
      assert.ok(
        files.endsWith(gitlinkEntry("wiki", change.oldSide, change.newSide)),
        "gitlink entry has no appended contents",
      );
      assert.ok(diff.includes("160000"));
      assert.equal(
        diff.includes(`-Subproject commit ${OLD_COMMIT}`),
        change.before !== null,
      );
      assert.equal(
        diff.includes(`+Subproject commit ${NEW_COMMIT}`),
        change.after !== null,
      );
      assert.equal(
        sh(
          `git -C ${worktree(n)} cat-file -e ${OLD_COMMIT} 2>/dev/null; echo $?`,
        ),
        "1",
      );
      assert.equal(reply.headSha, result?.sha ?? featureHead);
      assert.equal(sh(`git -C ${worktree(n)} rev-parse HEAD`), reply.headSha);
    });
  }
}

test("a moved gitlink is an old deleted path and a new added path", () => {
  const n = 110;
  baseGitlink(fx, OLD_COMMIT, "old-module");
  startBranch(fx, n, "marker", "move");
  setGitlink(fx, worktree(n), "old-module", null);
  setGitlink(fx, worktree(n), "new-module", OLD_COMMIT);
  commitIndex(n);
  const { files } = prepare(fx, n);
  assert.ok(files.includes(gitlinkEntry("old-module", OLD_SIDE, "absent")));
  assert.ok(files.includes(gitlinkEntry("new-module", "absent", OLD_SIDE)));
});

test("ordinary files and wiki changes retain their behavior alongside a gitlink", () => {
  const n = 111;
  baseGitlink(fx, OLD_COMMIT);
  fx.advanceBase("deleted.txt", "deleted full contents");
  startBranch(fx, n, "a-text", "initial text");
  const wt = worktree(n);
  fs.writeFileSync(path.join(wt, "a-text"), TEXT);
  fs.writeFileSync(path.join(wt, "binary"), Buffer.from("binary\0payload"));
  // These two names sort differently under JS's UTF-16 and byte order.
  fx.commitIn(n, "\u{10000}-text", "astral");
  fx.commitIn(n, "\uE000-text", "private-use");
  sh(`git -C ${wt} rm -q deleted.txt && git -C ${wt} add a-text binary`);
  setGitlink(fx, wt, "wiki", NEW_COMMIT);
  commitIndex(n);
  const config = pendingWiki(fx, n);
  const { diff, files, reply } = prepare(fx, n, null, config);
  assert.ok(diff.includes("+wiki page body"));
  assert.ok(!files.includes("wiki page body"));
  assert.ok(!files.includes("Page.md"));
  assert.deepEqual(
    Array.from(files.matchAll(HEADING), ([, file]) => file),
    [
      "a-text",
      "binary",
      "deleted.txt",
      "wiki",
      "\uE000-text",
      "\u{10000}-text",
    ],
  );
  assert.ok(files.includes(`\n\`\`\`\`\`\n${TEXT}\`\`\`\`\`\n`));
  assert.ok(files.includes("Binary: path only."));
  assert.ok(files.includes("Deleted at the head: path only."));
  assert.ok(!files.includes("binary\0payload"));
  assert.ok(!files.includes("deleted full contents"));
  assert.ok(files.includes(gitlinkEntry("wiki", OLD_SIDE, NEW_SIDE)));
  assert.equal(reply.bundleText, fs.readFileSync(reply.bundlePath, "utf8"));
});

test("gitlink identities survive the size bound and bundles repeat byte for byte", () => {
  const n = 112;
  const seed = path.join(fx.root, "seed");
  const big = `${"unchanged row\n".repeat(REVIEW_BUNDLE_MAX_CHARS / 10)}last row\n`;
  fs.writeFileSync(path.join(seed, "b-big"), big);
  sh(
    `git -C ${seed} add b-big && git -C ${seed} commit -qm big && git -C ${seed} push -q origin integration`,
  );
  startBranch(fx, n, "a-small", "small content");
  const wt = worktree(n);
  fs.writeFileSync(path.join(wt, "b-big"), `changed first row\n${big}`);
  fx.commitIn(n, "c-small", "later content");
  sh(`git -C ${wt} add b-big`);
  setGitlink(fx, wt, "wiki", NEW_COMMIT);
  commitIndex(n);
  const first = prepare(fx, n);
  const bytes = fs.readFileSync(first.reply.bundlePath);
  const second = prepare(fx, n);
  assert.ok(bytes.equals(fs.readFileSync(second.reply.bundlePath)));
  assert.equal(first.reply.bundleText, second.reply.bundleText);
  assert.ok(first.files.includes("small content"));
  for (const file of ["b-big", "c-small"]) {
    assert.ok(
      first.files.includes(
        `\n## ${file}\n\nPast the bundle's size bound: path only.`,
      ),
    );
  }
  assert.ok(!first.files.includes("last row"));
  assert.ok(!first.files.includes("later content"));
  assert.ok(first.files.includes(gitlinkEntry("wiki", OLD_SIDE, NEW_SIDE)));
});
