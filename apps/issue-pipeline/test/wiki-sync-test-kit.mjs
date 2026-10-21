// @ts-check
// Real rebase-divergent wiki histories and genuine strict saved-authority reads.
import fs from "node:fs";
import path from "node:path";
import {
  configIn,
  git,
  headOf,
  ISSUE,
  root,
  write,
} from "./pipeline-commit-test-kit.mjs";
import {
  saveAuthority,
  saveIssueAuthority,
} from "./write-authority-test-kit.mjs";

const { paths, withCheckout } = await import("../src/config.ts");
const { openJobCheckout } = await import("../src/job/checkout.ts");
const { trustedInputsHash } = await import("../src/issue-context.ts");
const { newIssueState } = await import("../src/state.ts");
const { configuredWikiRemote } = await import("../src/wiki-sync/authority.ts");
const { recordDir, recordIds } = await import("../src/wiki-sync/records.ts");
const { reconcileWikiSync } = await import("../src/wiki-sync/reconcile.ts");
const { syncWiki } = await import("../src/wiki-publish.ts");
const IDENTITY = { lane: "L", job: "original-job" };
const COMMIT_ENV = Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]);
const BRANCH = "agent/issue-7";
const SOURCE_ISSUE = {
  title: "Wiki repair",
  body: "Trusted requirements",
  user: { login: "alice" },
};

/** @param {string} wikiOrigin @param {string} docs */
function publishOtherWiki(wikiOrigin, docs) {
  const wikiSeed = `${wikiOrigin}-seed`;
  write(wikiSeed, "Other.md", "new published work\n");
  git(wikiSeed, ["add", "Other.md"]);
  git(wikiSeed, ["commit", "-m", "Published wiki"]);
  git(wikiSeed, ["push", wikiOrigin, "HEAD:master"]);
  git(docs, ["fetch", "origin"]);
  return headOf(wikiSeed);
}
function world() {
  const tmp = fs.mkdtempSync(path.join(root, "wiki-sync-"));
  const cfg = configIn(tmp);
  const origin = path.join(tmp, "origin.git");
  const wikiOrigin = path.join(tmp, "wiki-origin.git");
  const remote = configuredWikiRemote(cfg);
  fs.symlinkSync(wikiOrigin, remote, "dir");
  const seed = `${origin}-seed`;
  git(seed, ["config", "-f", ".gitmodules", "submodule.wiki.url", remote]);
  git(seed, ["commit", "-am", "Configured wiki remote"]);
  git(seed, ["push", origin, "HEAD:integration"]);
  const dirs = openJobCheckout({ ...cfg, recoveryLane: "L" }, ISSUE, {
    stage: "merge",
    branch: BRANCH,
  });
  if (dirs.docs === null) {
    throw new Error("missing wiki");
  }
  const { docs } = dirs;
  write(docs, "Issue.md", "issue work\n");
  git(docs, ["add", "Issue.md"]);
  git(docs, ["commit", "-m", "Issue wiki"], COMMIT_ENV);
  git(wikiOrigin, ["fetch", docs, `HEAD:refs/heads/${BRANCH}`]);
  const old = headOf(docs);
  git(paths.wikiMirror(cfg), ["fetch", docs, `HEAD:refs/heads/${BRANCH}`]);
  git(origin, ["fetch", dirs.repo, `HEAD:refs/heads/${BRANCH}`]);
  const scoped = {
    ...withCheckout(cfg, { issue: ISSUE, dir: dirs.repo, branch: BRANCH }),
    recoveryLane: "L",
  };
  saveIssueAuthority(cfg, SOURCE_ISSUE);
  const inputs = trustedInputsHash(cfg, SOURCE_ISSUE, []);
  const state = {
    ...newIssueState(ISSUE),
    stage: /** @type {const} */ ("merge"),
    branch: BRANCH,
    flows: { code: true, wiki: true },
    hardened: { code: headOf(dirs.repo), wiki: old, inputs },
    gherkin: { commentId: 3, rev: 1, inputs },
    lease: { lane: "L", sweepId: "s1", at: new Date().toISOString() },
  };
  saveAuthority(cfg, state);
  const target = publishOtherWiki(wikiOrigin, docs);
  return {
    cfg,
    scoped,
    dirs: { ...dirs, docs },
    old,
    target,
    state,
    tmp,
    remote,
    wikiOrigin,
    origin,
  };
}
/** @param {ReturnType<typeof world>} w */
function synced(w) {
  const reply = syncWiki(w.scoped, ISSUE, IDENTITY);
  if (reply.conflict || !reply.changed) {
    throw new Error("expected clean changed sync");
  }
  return { next: reply.headSha, ...checkpoint(w) };
}
/** @param {ReturnType<typeof world>} w */
function checkpoint(w) {
  const [id] = recordIds(w.cfg, ISSUE);
  if (id === undefined) {
    throw new Error("no durable checkpoint");
  }
  return { id, folder: recordDir(w.cfg, ISSUE, id) };
}
/** @param {ReturnType<typeof world>} w @param {string} id */
function reconcile(w, id) {
  return reconcileWikiSync(w.scoped, {
    number: ISSUE,
    id,
    lane: "L",
    retained: w.dirs.docs,
  });
}
/** @param {ReturnType<typeof world>} w */
function relocate(w) {
  const moved = `${w.dirs.root}-retained`;
  fs.renameSync(w.dirs.root, moved);
  return path.join(moved, "docs");
}
/** @param {ReturnType<typeof world>} w */
function reopen(w) {
  return openJobCheckout({ ...w.cfg, recoveryLane: "L" }, ISSUE, {
    stage: "merge",
    branch: BRANCH,
  });
}

export {
  BRANCH,
  COMMIT_ENV,
  checkpoint,
  IDENTITY,
  paths,
  reconcile,
  relocate,
  reopen,
  SOURCE_ISSUE,
  synced,
  world,
};
