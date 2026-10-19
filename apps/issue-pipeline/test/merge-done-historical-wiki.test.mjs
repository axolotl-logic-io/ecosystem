// @ts-check
// Already-published wiki history is not an unpublished diff for a fresh receipt.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  AFTER_MERGE,
  MERGED_REVISION,
  merging,
  NO_FINDING,
  PREPARED_MERGED,
} from "./merge-role-test-kit.mjs";
import {
  opNames,
  savesOf,
  sessionsOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  fakeContext,
  MERGE_COMMIT,
  mergeRole,
} from "./reviewer-and-merge-role-kit.mjs";

const { ROOT } = await import("../src/pipeline-root.ts");
const { withCheckout } = await import("../src/config.ts");
const { wikiDiff } = await import("../src/wiki.ts");
const NEEDS_RECONCILIATION = /historical wiki.*reconcil/u;

/** @param {string} dir @param {string[]} args */
function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function publishedWiki() {
  const root = fs.mkdtempSync(path.join(ROOT, "historical-wiki-"));
  const docs = path.join(root, "docs");
  fs.mkdirSync(docs);
  git(docs, ["init", "--quiet", "-b", "main"]);
  git(docs, ["config", "user.name", "test"]);
  git(docs, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(docs, "Home.md"), "baseline\n");
  git(docs, ["add", "Home.md"]);
  git(docs, ["commit", "-qm", "Baseline"]);
  fs.writeFileSync(path.join(docs, "Home.md"), "published W material\n");
  git(docs, ["commit", "-qam", "Published W"]);
  const wiki = git(docs, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(docs, "Home.md"), "later B replaces W material\n");
  git(docs, ["commit", "-qam", "Published B"]);
  const after = git(docs, ["rev-parse", "HEAD"]);
  git(docs, ["update-ref", "refs/remotes/origin/main", after]);
  return { root, wiki, after };
}

for (const stale of [false, true]) {
  test(`done replay refuses fresh historical wiki clearance with stale receipt ${stale}`, async () => {
    const { root, wiki, after } = publishedWiki();
    const merged = { ...MERGED_REVISION, wiki };
    const state = {
      ...merging().ctx.state,
      stage: /** @type {const} */ ("done"),
      merged,
    };
    if (stale) {
      state.security = {
        revision: { ...merged, wiki: after },
        commentId: 12,
        finding: null,
      };
    }
    const current = { ...AFTER_MERGE, revision: { ...merged, wiki: after } };
    const { ctx, calls } = fakeContext({
      stage: "merge",
      state,
      ops: {
        "current-revision": [current, current],
        verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
        "wiki-check": [{ pass: true, checks: [] }],
        "prepare-review": [PREPARED_MERGED],
        "finish-wiki": [{ finished: true, closed: true }],
      },
      sessions: [NO_FINDING],
    });
    const scoped = withCheckout(
      { ...ctx.cfg, wiki: { dir: "docs", branch: "main" } },
      {
        issue: ctx.issue,
        dir: path.join(root, "repo"),
        branch: "agent/issue-7",
      },
    );
    assert.deepEqual(wikiDiff(scoped, ctx.issue), { diff: "", files: [] });
    const end = await mergeRole(ctx);
    assert.equal(end.kind, "stop");
    assert.ok(end.kind === "stop");
    assert.match(end.reason, NEEDS_RECONCILIATION);
    assert.equal(sessionsOf(calls).length, 0);
    assert.equal(opNames(calls).includes("finish-wiki"), false);
    assert.ok(
      savesOf(calls).every((saved) => saved.security === state.security),
    );
  });
}
