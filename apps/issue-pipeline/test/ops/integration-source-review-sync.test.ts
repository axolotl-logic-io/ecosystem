// prepare-review once the code merged (src/ops/prepare-review.ts,
// merged-review.ts) and finish-sync's abort (src/ops/sync.ts), through the
// ops CLI against a local origin and the fake gh: GitHub's confirmed merge
// commit is the reviewed head, its change against its first parent, docs/
// included, is reviewed, with the checkout detached at it; a merge GitHub doesn't confirm, or a commit not on the
// base, writes nothing; an aborted, fully staged resolution is preserved
// before leaving the worktree clean on the pushed branch. merged-review-ops.test.ts has the rest.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  historyReply,
  initialWriteStateReply,
} from "../initial-write-state-fixtures.ts";
import { isolatedOpsFixture } from "../integration-source-test-kit.ts";
import type { OpsFixture } from "../ops-fixtures.ts";

const fx: OpsFixture = await isolatedOpsFixture(
  "integration-source-review-sync",
);
fx.fakeGh.requireReplies();
const { fakeGh, sh, worktree, originRef }: OpsFixture = fx;
const { loadConfig, paths }: typeof import("../../src/config.ts") =
  await import("../../src/config.ts");

const ISSUE = { merged: 31, aborted: 32, abortedNoReason: 33 };
const PR = 7;
const BASE = "integration";
const REVIEW_REPLY = z.looseObject({
  ok: z.literal(true),
  headSha: z.string(),
  headTree: z.string(),
  baseSha: z.string(),
  patchId: z.null(),
  diffPath: z.string(),
  changedFiles: z.array(z.string()),
  bundleText: z.string(),
});
const ERROR_REPLY = z.object({ ok: z.literal(false), error: z.string() });
const NOT_CONFIRMED = /doesn't report PR #7 merged as/u;
const NOT_ON_BASE = /is not on origin\/integration/u;
const KEPT_CONFLICT = z.looseObject({
  conflict: z.literal(true),
  inRebase: z.boolean(),
});

function parsed(out: string): unknown {
  return JSON.parse(out);
}

// Merges issue `n`'s pushed branch into the base on origin with a merge
// commit, as GitHub would; returns the merge commit.
function mergeOnOrigin(n: number): string {
  const seed = path.join(fx.root, "seed");
  sh(`cd ${seed} && git checkout -q ${BASE} && git pull -q origin ${BASE}`);
  sh(`cd ${seed} && git fetch -q origin agent/issue-${n}`);
  sh(`cd ${seed} && git merge -q --no-ff -m "Merge PR #${PR}" FETCH_HEAD`);
  sh(`cd ${seed} && git push -q origin HEAD:${BASE}`);
  return originRef(BASE);
}

// gh's `pr view` answer for issue `n`'s PR.
function prView(
  n: number,
  {
    state,
    mergeCommit,
    head,
  }: { state: string; mergeCommit: string | null; head: string },
): { when: string; stdout: string; keep: boolean } {
  let merge: { oid: string } | null = null;
  if (mergeCommit !== null) {
    merge = { oid: mergeCommit };
  }
  const view = {
    number: PR,
    state,
    mergeCommit: merge,
    headRefName: `agent/issue-${n}`,
    headRefOid: head,
    baseRefName: BASE,
    isCrossRepository: false,
  };
  return { when: `pr view ${PR}`, stdout: JSON.stringify(view), keep: true };
}

function reviewDir(n: number, tag: string): string {
  const config = path.join(fx.root, "config.json");
  return path.join(paths.runDir(loadConfig(config), n), `review-${tag}`);
}

// Issue `n`'s branch with a code change and a docs page, pushed; returns the
// branch head.
function branchWithDocsPage(n: number): string {
  fx.startBranch(n, "code.txt", "feature line");
  fs.mkdirSync(path.join(worktree(n), "docs"));
  fx.commitIn(n, "docs/Page.md", "page");
  return fx.pushFrom(n);
}

const branchHead = branchWithDocsPage(ISSUE.merged);
const mergeSha = mergeOnOrigin(ISSUE.merged);

test("prepare-review with a confirmed code merge reviews the merge commit's first-parent change, docs included, at the merged checkout", () => {
  const merged = { state: "MERGED", mergeCommit: mergeSha, head: branchHead };
  fakeGh.reply([prView(ISSUE.merged, merged)]);
  const request = {
    op: "prepare-review",
    number: ISSUE.merged,
    tag: "r1",
    codeMerged: { pr: PR, sha: mergeSha },
  };
  const reply = REVIEW_REPLY.parse(parsed(fx.ask(request)));
  const seed = path.join(fx.root, "seed");
  const parent = sh(`git -C ${seed} rev-parse ${mergeSha}^1`);
  assert.equal(reply.headSha, mergeSha);
  assert.equal(reply.baseSha, parent);
  assert.equal(reply.patchId, null);
  assert.equal(sh(`git -C ${worktree(ISSUE.merged)} rev-parse HEAD`), mergeSha);
  assert.equal(
    reply.headTree,
    sh(`git -C ${seed} rev-parse ${mergeSha}^{tree}`),
  );
  assert.deepEqual(reply.changedFiles, ["code.txt", "docs/Page.md"]);
  assert.equal(
    reply.diffPath,
    path.join(reviewDir(ISSUE.merged, "r1"), "diff.patch"),
  );
  const diff = fs.readFileSync(reply.diffPath, "utf8");
  assert.ok(diff.includes(mergeSha));
  assert.ok(diff.includes(parent));
  assert.ok(diff.includes("+feature line"), diff);
  assert.ok(diff.includes("+page"), diff);
  assert.ok(reply.bundleText.startsWith(diff), "the bundle starts with it");
  for (const call of fakeGh.calls()) {
    assert.deepEqual(call.slice(0, 2), ["pr", "view"], call.join(" "));
  }
});

test("prepare-review refuses a merge GitHub doesn't confirm and writes nothing", () => {
  const before = sh(
    `git -C ${path.join(fx.root, "seed")} rev-parse ${mergeSha}^1`,
  );
  const cases = [
    // GitHub's merge commit is another one.
    {
      view: { state: "MERGED", mergeCommit: mergeSha },
      sha: before,
      tag: "wrong-sha",
    },
    // GitHub reports the PR open.
    { view: { state: "OPEN", mergeCommit: null }, sha: mergeSha, tag: "open" },
  ];
  for (const { view, sha, tag } of cases) {
    fakeGh.reply([prView(ISSUE.merged, { ...view, head: branchHead })]);
    const request = {
      op: "prepare-review",
      number: ISSUE.merged,
      tag,
      codeMerged: { pr: PR, sha },
    };
    const reply = ERROR_REPLY.parse(parsed(fx.ask(request)));
    assert.match(reply.error, NOT_CONFIRMED, tag);
    assert.equal(fs.existsSync(reviewDir(ISSUE.merged, tag)), false, tag);
  }
});

test("prepare-review refuses a confirmed merge commit that isn't on the base and writes nothing", () => {
  const stray = fx.commitIn(ISSUE.merged, "stray.txt", "not on the base");
  const view = { state: "MERGED", mergeCommit: stray, head: branchHead };
  fakeGh.reply([prView(ISSUE.merged, view)]);
  const request = {
    op: "prepare-review",
    number: ISSUE.merged,
    tag: "off-base",
    codeMerged: { pr: PR, sha: stray },
  };
  const reply = ERROR_REPLY.parse(parsed(fx.ask(request)));
  assert.match(reply.error, NOT_ON_BASE);
  assert.equal(fs.existsSync(reviewDir(ISSUE.merged, "off-base")), false);
});

// Issue `n` with a rebase kept stopped on a conflict and an untracked file,
// as a resolver leaves it: the pushed branch head, sync-base's reply and
// whether the rebase is stopped.
function keptConflict(n: number): {
  pushed: string;
  synced: unknown;
  inRebase: boolean;
} {
  const pushed = fx.startBranch(n, `c${n}.txt`, "mine");
  fx.advanceBase(`c${n}.txt`, "theirs");
  fakeGh.reply([initialWriteStateReply(n), historyReply(n)]);
  const synced = parsed(
    fx.ask({ op: "sync-base", number: n, keepConflict: true }),
  );
  fs.writeFileSync(path.join(worktree(n), "scratch.txt"), "half a fix\n");
  return { pushed, synced, inRebase: fx.inRebase(n) };
}

test("finish-sync's abort preserves a staged resolution and resets to the pushed branch, with its reason", () => {
  for (const { n, reason, expected } of [
    {
      n: ISSUE.aborted,
      reason: "the resolver gave up",
      expected: "the resolver gave up",
    },
    { n: ISSUE.abortedNoReason, reason: undefined, expected: "aborted" },
  ]) {
    const { pushed, synced, inRebase } = keptConflict(n);
    assert.equal(KEPT_CONFLICT.parse(synced).inRebase, true);
    assert.equal(inRebase, true);
    sh(`git -C ${worktree(n)} add c${n}.txt`);
    fakeGh.reply([initialWriteStateReply(n), historyReply(n)]);
    const out = parsed(
      fx.ask({ op: "finish-sync", number: n, abort: true, reason }),
    );
    assert.deepEqual(out, {
      ok: true,
      op: "finish-sync",
      posted: 0,
      commentIds: [],
      resolved: false,
      reason: expected,
    });
    assert.equal(fx.inRebase(n), false);
    assert.deepEqual(fx.worktreeState(n), { head: pushed, status: "" });
    assert.equal(originRef(`agent/issue-${n}`), pushed);
  }
});
