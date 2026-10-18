// @ts-check
// prepare-review once the code merged (src/ops/prepare-review.ts) and
// finish-sync's abort (src/ops/sync.ts), through the ops CLI against a local
// origin, a local wiki origin and the fake gh: GitHub's confirmed merge
// commit is the reviewed head and only the wiki change is left to review; a
// merge GitHub doesn't confirm, or a commit not on the base, writes nothing;
// an aborted resolution leaves the worktree clean on the pushed branch.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { isolatedOpsFixture } from "./integration-source-test-kit.mjs";

const fx = await isolatedOpsFixture("integration-source-review-sync");
const { fakeGh, sh, worktree, originRef } = fx;
const { loadConfig, paths } = await import("../src/config.ts");

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
const WIKI_HEADING = "# Wiki changes (paths under wiki/;";

/** @param {string} out @returns {unknown} */
function parsed(out) {
  return JSON.parse(out);
}

// A config with a wiki whose origin holds one page on master.
function wikiConfig() {
  const wikiOrigin = path.join(fx.root, "wiki.git");
  const seed = path.join(fx.root, "wiki-seed");
  sh(`git init -q --bare -b master ${wikiOrigin}`);
  sh(`git clone -q ${wikiOrigin} ${seed} 2>/dev/null`);
  sh(`cd ${seed} && echo home > Home.md && git add . && git commit -qm home`);
  sh(`cd ${seed} && git push -q origin HEAD:master`);
  return {
    file: fx.configWith("wiki-config.json", { wiki: { url: wikiOrigin } }),
    wikiOrigin,
  };
}

const wiki = wikiConfig();

// Merges issue `n`'s pushed branch into the base on origin with a merge
// commit, as GitHub would; returns the merge commit.
/** @param {number} n @returns {string} */
function mergeOnOrigin(n) {
  const seed = path.join(fx.root, "seed");
  sh(`cd ${seed} && git checkout -q ${BASE} && git pull -q origin ${BASE}`);
  sh(`cd ${seed} && git fetch -q origin agent/issue-${n}`);
  sh(`cd ${seed} && git merge -q --no-ff -m "Merge PR #${PR}" FETCH_HEAD`);
  sh(`cd ${seed} && git push -q origin HEAD:${BASE}`);
  return originRef(BASE);
}

// gh's `pr view` answer for issue `n`'s PR.
/** @param {number} n @param {{ state: string, mergeCommit: string | null, head: string }} pr */
function prView(n, { state, mergeCommit, head }) {
  let merge = null;
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

/** @param {number} n @param {string} tag @returns {string} */
function reviewDir(n, tag) {
  return path.join(paths.runDir(loadConfig(wiki.file), n), `review-${tag}`);
}

// Issue `n`'s branch with a code change, pushed, and a wiki page committed in
// its wiki checkout; returns the branch head.
/** @param {number} n @returns {string} */
function branchWithWikiPage(n) {
  const head = fx.startBranch(n, "code.txt", "feature line");
  const dir = path.join(worktree(n), "wiki");
  sh(`git clone -q ${wiki.wikiOrigin} ${dir} 2>/dev/null`);
  sh(`cd ${dir} && echo page > Page.md && git add . && git commit -qm page`);
  return head;
}

const branchHead = branchWithWikiPage(ISSUE.merged);
const mergeSha = mergeOnOrigin(ISSUE.merged);

test("prepare-review with a confirmed code merge reviews the merge commit and only the wiki change", () => {
  const merged = { state: "MERGED", mergeCommit: mergeSha, head: branchHead };
  fakeGh.reply([prView(ISSUE.merged, merged)]);
  const request = {
    op: "prepare-review",
    number: ISSUE.merged,
    tag: "r1",
    codeMerged: { pr: PR, sha: mergeSha },
  };
  const reply = REVIEW_REPLY.parse(parsed(fx.ask(request, wiki.file)));
  assert.equal(reply.headSha, mergeSha);
  assert.equal(reply.baseSha, mergeSha);
  assert.equal(reply.patchId, null);
  const seed = path.join(fx.root, "seed");
  assert.equal(
    reply.headTree,
    sh(`git -C ${seed} rev-parse ${mergeSha}^{tree}`),
  );
  assert.deepEqual(reply.changedFiles, ["wiki/Page.md"]);
  assert.equal(
    reply.diffPath,
    path.join(reviewDir(ISSUE.merged, "r1"), "diff.patch"),
  );
  const diff = fs.readFileSync(reply.diffPath, "utf8");
  assert.ok(
    diff.startsWith(
      `# Code\n\nThe code merged as ${mergeSha} (PR #${PR}); only the wiki change below remains.\n`,
    ),
    diff,
  );
  assert.ok(diff.includes(WIKI_HEADING), diff);
  assert.ok(diff.includes("+page"), diff);
  assert.equal(diff.includes("feature line"), false, diff);
  assert.equal(reply.bundleText.includes("feature line"), false);
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
    const reply = ERROR_REPLY.parse(parsed(fx.ask(request, wiki.file)));
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
  const reply = ERROR_REPLY.parse(parsed(fx.ask(request, wiki.file)));
  assert.match(reply.error, NOT_ON_BASE);
  assert.equal(fs.existsSync(reviewDir(ISSUE.merged, "off-base")), false);
});

// Issue `n` with a rebase kept stopped on a conflict and an untracked file,
// as a resolver leaves it: the pushed branch head, sync-base's reply and
// whether the rebase is stopped.
/** @param {number} n @returns {{ pushed: string, synced: unknown, inRebase: boolean }} */
function keptConflict(n) {
  const pushed = fx.startBranch(n, `c${n}.txt`, "mine");
  fx.advanceBase(`c${n}.txt`, "theirs");
  fakeGh.reply([]);
  const synced = parsed(
    fx.ask({ op: "sync-base", number: n, keepConflict: true }),
  );
  fs.writeFileSync(path.join(worktree(n), "scratch.txt"), "half a fix\n");
  return { pushed, synced, inRebase: fx.inRebase(n) };
}

test("finish-sync's abort drops the rebase and resets to the pushed branch, with its reason", () => {
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
    fakeGh.reply([]);
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
