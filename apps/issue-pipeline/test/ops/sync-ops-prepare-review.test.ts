// prepare-review: its reply and the review diff it writes, run through the ops
// CLI against a local origin. It never calls gh. Split from sync-ops.test.ts,
// which no longer fit in 300 lines. With no stacked branches (#268) the diff
// is always from the branch's merge base with the base ("prepare-review diffs
// the branch from its merge base"), so the stacked case is retired; an issue
// whose prerequisite is open doesn't start (orchestrator.test "an open
// prerequisite in the after mark holds…").
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { OpsFixture } from "../ops-fixtures.ts";
import { okLine, opsFixture } from "../ops-fixtures.ts";

const fx: OpsFixture = await opsFixture("sync-ops-prepare-review");
const { fakeGh, sh, worktree }: OpsFixture = fx;
const BASE = "origin/integration";
// Each test's issue.
const ISSUE = {
  mergeBase: 21,
  sinceSha: 22,
  rebasedSince: 23,
  docs: 24,
  messages: 27,
};
// The two commits after sinceSha, oldest first.
const COMMITS_IN_ORDER =
  /^# Commits, oldest first\n\ncommit \w+\n\nfix a flaky check\n\ncommit \w+\n\nsimplify the parser\n\n$/u;
// Runs an op; returns its stdout and the gh calls it made.
function ask(request: object): { out: string; calls: string[][] } {
  fakeGh.reply([]);
  const out = fx.ask(request);
  return { out, calls: fakeGh.calls() };
}

function gitIn(dir: string, args: string): string {
  return sh(`git -C ${dir} ${args}`);
}

// A diff exactly as git prints it, untrimmed.
function patch(dir: string, range: string): string {
  const args = ["-C", dir, "diff", "--stat", "--patch", range];
  return spawnSync("git", args, { encoding: "utf8" }).stdout;
}

// The review file's code part: the range's commit messages, then its diff.
function codePart(dir: string, range: string): string {
  const format = "--format=commit %h%n%n%B";
  const log = gitIn(dir, `log --reverse '${format}' ${range}`);
  return `# Commits, oldest first\n\n${log}\n\n# Diff\n\n${patch(dir, range)}`;
}

// git's verbatim patch id of the diff `range`, or null when it prints none
// (#394).
function patchIdIn(dir: string, range: string): string | null {
  const out = sh(
    `git -C ${dir} diff --binary ${range} | git patch-id --verbatim`,
  );
  return out.split(" ")[0] || null;
}

interface Review {
  file: string;
  reply: {
    headSha: string;
    headTree: string;
    baseSha: string;
    patchId: string | null;
    diffPath: string;
    diffLines: number;
    changedFiles: string[];
  };
}

// What prepare-review should reply and write for the diff `from..HEAD`.
function review(n: number, from: string | undefined, tag: string): Review {
  const wt = worktree(n);
  const headSha = gitIn(wt, "rev-parse HEAD");
  const headTree = gitIn(wt, `rev-parse ${headSha}^{tree}`);
  const baseSha = gitIn(wt, `merge-base ${BASE} HEAD`);
  const file = codePart(wt, `${from ?? baseSha}..${headSha}`);
  const names = gitIn(wt, `diff --name-only ${baseSha}..${headSha}`);
  const patchId = patchIdIn(wt, `${baseSha} ${headSha}`);
  const diffPath = path.join(
    fx.root,
    "runs",
    "o__r",
    `issue-${n}`,
    `review-${tag}`,
    "diff.patch",
  );
  const changedFiles = names.split("\n");
  const diffLines = file.split("\n").length;
  return {
    file,
    reply: {
      headSha,
      headTree,
      baseSha,
      patchId,
      diffPath,
      diffLines,
      changedFiles,
    },
  };
}

// What prepare-review replied and wrote, beside what it should have. The
// replies are compared as objects, since nothing promises their key order.
// The bundle's fields are left out: sync-ops-prepare-review-bundle.test.ts
// checks them against the bundle it wrote (#415).
function reviewOutcome(
  out: string,
  want: Review,
): {
  got: { reply: unknown; file: string };
  expected: { reply: unknown; file: string };
} {
  const file = fs.readFileSync(want.reply.diffPath, "utf8");
  const expected = JSON.parse(okLine("prepare-review", want.reply));
  const { bundlePath, bundleLines, bundleText, ...reply } = JSON.parse(out);
  return {
    got: { reply, file },
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

test("prepare-review lists the reviewed commits' messages, oldest first, above the diff", () => {
  const n = ISSUE.messages;
  const since = fx.startBranch(n, "g", "one");
  fx.commitIn(n, "h", "two", "fix a flaky check");
  fx.commitIn(n, "i", "three", "simplify the parser");
  ask({ op: "prepare-review", number: n, sinceSha: since, tag: "r1" });
  const file = fs.readFileSync(review(n, since, "r1").reply.diffPath, "utf8");
  const top = file.slice(0, file.indexOf("# Diff"));
  assert.match(top, COMMITS_IN_ORDER);
  assert.ok(!top.includes("edit g"));
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

test("prepare-review reviews a docs/ page with the code", () => {
  const n = ISSUE.docs;
  fx.startBranch(n, "g", "one");
  fs.mkdirSync(path.join(worktree(n), "docs"));
  fx.commitIn(n, "docs/Page.md", "page");
  const { out, calls } = ask({ op: "prepare-review", number: n });
  assert.deepEqual(calls, []);
  const want = review(n, undefined, "r0");
  assert.deepEqual(want.reply.changedFiles, ["docs/Page.md", "g"]);
  assert.ok(want.file.includes("+page"), want.file);
  const { got, expected } = reviewOutcome(out, want);
  assert.deepEqual(got, expected);
});
