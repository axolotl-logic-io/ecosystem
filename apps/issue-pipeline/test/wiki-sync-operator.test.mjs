// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { git, headOf, ISSUE, write } from "./pipeline-commit-test-kit.mjs";
import {
  BRANCH,
  COMMIT_ENV,
  checkpoint,
  IDENTITY,
  paths,
  reconcile,
  relocate,
  reopen,
  synced,
  world,
} from "./wiki-sync-test-kit.mjs";
import { saveAuthority } from "./write-authority-test-kit.mjs";

const { syncWiki, finishWikiSync } = await import("../src/wiki-publish.ts");
const { selectLegacyWiki } = await import("../src/wiki-sync/operator.ts");
const { assertNoUncertainWikiPush, recordIds } = await import(
  "../src/wiki-sync/records.ts"
);
const EXISTING = /no existing wiki sync evidence/u;
const { recoveredWikiRevision } = await import("../src/wiki-sync/selection.ts");
const STOPPED = /reconciliation|attribut|diverged|recovery|authority/u;

test("a resolved rebase retains its original old head and fetched target before pushing", () => {
  const w = world();
  write(w.dirs.docs, "Home.md", "issue home\n");
  git(w.dirs.docs, ["commit", "-am", "Issue conflicting change"], COMMIT_ENV);
  const old = headOf(w.dirs.docs);
  git(w.wikiOrigin, ["fetch", w.dirs.docs, `+HEAD:refs/heads/${BRANCH}`]);
  git(paths.wikiMirror(w.cfg), [
    "fetch",
    w.dirs.docs,
    `+HEAD:refs/heads/${BRANCH}`,
  ]);
  saveAuthority(w.cfg, {
    ...w.state,
    hardened: { ...w.state.hardened, wiki: old },
  });
  const seed = `${w.wikiOrigin}-seed`;
  write(seed, "Home.md", "published home\n");
  git(seed, ["commit", "-am", "Published conflicting change"]);
  git(seed, ["push", w.wikiOrigin, "HEAD:master"]);
  const conflict = syncWiki(w.scoped, ISSUE, IDENTITY);
  assert.equal(conflict.conflict, true);
  const { id, folder } = checkpoint(w);
  write(w.dirs.docs, "Home.md", "resolved home\n");
  git(w.dirs.docs, ["add", "Home.md"]);
  git(
    w.dirs.docs,
    ["-c", "core.editor=true", "rebase", "--continue"],
    COMMIT_ENV,
  );
  const result = finishWikiSync(w.scoped, ISSUE, null, IDENTITY);
  assert.equal(result.resolved, true);
  const prep = JSON.parse(
    fs.readFileSync(path.join(folder, "preparation.json"), "utf8"),
  );
  assert.equal(prep.old, old);
  assert.equal(prep.target, headOf(seed));
  assert.equal(prep.expected, old);
  assert.equal(reconcile(w, id).response, "acknowledged");
  assert.equal(git(w.wikiOrigin, ["rev-parse", BRANCH]), headOf(w.dirs.docs));
});

/** @param {string} evidence */
function legacyIncident(evidence) {
  const w = world();
  git(w.dirs.docs, ["rebase", "origin/master"], COMMIT_ENV);
  const next = headOf(w.dirs.docs);
  git(w.wikiOrigin, ["fetch", w.dirs.docs, `+HEAD:refs/heads/${BRANCH}`]);
  const jobEvidence = path.join(w.tmp, "preserved-job.json");
  let lane = "L";
  let outcome = "ok";
  if (evidence === "wrong lane") {
    lane = "other";
  }
  if (evidence === "no successful sync") {
    outcome = "failed";
  }
  fs.writeFileSync(
    jobEvidence,
    JSON.stringify({
      id: "historical-job",
      issue: ISSUE,
      stage: "merge",
      lane,
      launches: [{ key: "wiki-sync-8", kind: "ops", outcome }],
    }),
  );
  const retained = relocate(w);
  const req = {
    number: ISSUE,
    lane: "L",
    retained,
    old: w.old,
    next,
    target: w.target,
    jobEvidence,
    rationale:
      "Operator verified the preserved successful sync launch against original saved hardening and the exact remote issue history; no unaccounted work remains.",
  };
  return { w, req, next };
}
for (const evidence of ["no successful sync", "wrong lane"]) {
  test(`pre-checkpoint ${evidence} cannot justify a selection`, () => {
    const { w, req } = legacyIncident(evidence);
    assert.throws(() => selectLegacyWiki(w.scoped, req), STOPPED);
    assert.deepEqual(recordIds(w.cfg, ISSUE), []);
  });
}
test("corroborated pre-checkpoint selection records only an explicit present-day operator decision", () => {
  const { w, req, next } = legacyIncident("corroborated");
  const selected = selectLegacyWiki(w.scoped, req);
  assert.equal(selected.selected, true);
  assert.doesNotThrow(() => assertNoUncertainWikiPush(w.cfg, ISSUE));
  const folder = path.join(
    paths.runDir(w.cfg, ISSUE),
    "wiki-sync",
    selected.id,
  );
  assert.equal(fs.existsSync(path.join(folder, "operator.json")), true);
  assert.equal(fs.existsSync(path.join(folder, "intent.json")), false);
  assert.equal(fs.existsSync(path.join(folder, "completion.json")), false);
  const opened = reopen(w);
  assert.equal(headOf(opened.docs ?? ""), next);
  assert.equal(git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]), w.old);
  assert.equal(git(w.wikiOrigin, ["rev-parse", "master"]), w.target);
  assert.throws(() => selectLegacyWiki(w.scoped, req), EXISTING);
});

for (const remote of ["absent", "ancestor"]) {
  test(`private-only commits survive ordinary selection with ${remote} remote`, () => {
    const w = world();
    write(w.dirs.docs, "Private.md", "never published\n");
    git(w.dirs.docs, ["add", "Private.md"]);
    git(w.dirs.docs, ["commit", "-m", "Private-only work"], COMMIT_ENV);
    const privateHead = headOf(w.dirs.docs);
    git(paths.wikiMirror(w.cfg), [
      "fetch",
      w.dirs.docs,
      `+HEAD:refs/heads/${BRANCH}`,
    ]);
    if (remote === "absent") {
      git(w.wikiOrigin, ["update-ref", "-d", `refs/heads/${BRANCH}`]);
    }
    relocate(w);
    const opened = reopen(w);
    assert.equal(headOf(opened.docs ?? ""), privateHead);
    assert.equal(
      git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]),
      privateHead,
    );
    assert.notEqual(git(w.wikiOrigin, ["rev-parse", "master"]), privateHead);
  });
}

test("external rebase divergence without a checkpoint never becomes checkout authority", () => {
  const w = world();
  git(w.dirs.docs, ["rebase", "origin/master"], COMMIT_ENV);
  write(w.dirs.docs, "External.md", "external change\n");
  git(w.dirs.docs, ["add", "External.md"]);
  git(w.dirs.docs, ["commit", "-m", "External work"], COMMIT_ENV);
  const external = headOf(w.dirs.docs);
  git(w.wikiOrigin, ["fetch", w.dirs.docs, `+HEAD:refs/heads/${BRANCH}`]);
  relocate(w);
  assert.throws(() => reopen(w), STOPPED);
  assert.equal(git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]), w.old);
  assert.equal(git(w.wikiOrigin, ["rev-parse", BRANCH]), external);
  assert.deepEqual(recordIds(w.cfg, ISSUE), []);
});

test("an additional clean retained branch is work, even with identical patches and an exact synced HEAD", () => {
  const w = world();
  const { id, next } = synced(w);
  const tree = git(w.dirs.docs, ["rev-parse", "HEAD^{tree}"]);
  const extra = git(
    w.dirs.docs,
    ["commit-tree", tree, "-p", next, "-m", "Unique branch history"],
    COMMIT_ENV,
  );
  git(w.dirs.docs, ["update-ref", "refs/heads/retained-extra", extra]);
  assert.equal(headOf(w.dirs.docs), next);
  assert.equal(git(w.dirs.docs, ["status", "--porcelain"]), "");
  assert.throws(() => reconcile(w, id), STOPPED);
  assert.equal(git(w.dirs.docs, ["rev-parse", "retained-extra"]), extra);
  assert.equal(git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]), w.old);
  assert.equal(git(w.wikiOrigin, ["rev-parse", BRANCH]), next);
});

test("a saved exact wiki-only integration resumes normally rather than repeatedly treating it as interrupted work", () => {
  const w = world();
  const { id, next } = synced(w);
  reconcile(w, id);
  git(paths.wikiMirror(w.cfg), [
    "fetch",
    "--refmap=",
    "origin",
    `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`,
  ]);
  const revision = { ...w.state.hardened, wiki: next };
  assert.equal(recoveredWikiRevision(w.scoped, ISSUE, "L", revision), true);
  saveAuthority(w.cfg, {
    ...w.state,
    integration: { reviewed: w.state.hardened, revision },
  });
  assert.equal(recoveredWikiRevision(w.scoped, ISSUE, "L", revision), false);
  assert.equal(git(w.wikiOrigin, ["rev-parse", BRANCH]), next);
  assert.equal(git(w.wikiOrigin, ["rev-parse", "master"]), w.target);
});
