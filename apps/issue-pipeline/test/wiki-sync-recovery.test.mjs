// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
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
  SOURCE_ISSUE,
  synced,
  world,
} from "./wiki-sync-test-kit.mjs";
import {
  saveAuthority,
  saveIssueAuthority,
} from "./write-authority-test-kit.mjs";

const { reconcileWikiSync } = await import("../src/wiki-sync/reconcile.ts");
const { prepareWikiSync, pushSyncedWiki } = await import(
  "../src/wiki-sync/checkpoint.ts"
);
const { recoveredWikiRevision } = await import("../src/wiki-sync/selection.ts");
const { pushWikiBranch } = await import("../src/wiki.ts");
const DIVERGED = /diverged|reconciliation|recovery/u;
const REFUSED =
  /authority|identity|attribut|inputs|claim|conflict|unreadable|additional|remote|reconciliation/u;
const UNCERTAIN =
  /unresolved wiki push intent|conflicting wiki push completion/u;
const OTHER_ISSUE = 8;
const CHILD_MS = 60_000;

/** @param {ReturnType<typeof world>} w @param {string} phase */
function interrupted(w, phase) {
  const child = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "wiki-sync-crash-child.mjs"),
      path.join(w.tmp, "config.json"),
      w.dirs.repo,
      phase,
    ],
    { encoding: "utf8", timeout: CHILD_MS },
  );
  return child;
}

for (const phase of [
  "after push",
  "after pin",
  "during verify",
  "lost response",
]) {
  test(`interruption ${phase} reconciles before checkout selection without job status, repush or authority`, () => {
    const w = world();
    const child = interrupted(w, phase);
    assert.equal(child.signal, "SIGKILL", child.stderr);
    if (phase === "lost response") {
      // SIGKILL retained this dead child's lock; caller-owned exclusion is explicit.
      fs.rmSync(`${paths.wikiMirror(w.cfg)}.lock`, { recursive: true });
    }
    const { id, folder } = checkpoint(w);
    const intentBytes = fs.readFileSync(path.join(folder, "intent.json"));
    const next = headOf(w.dirs.docs);
    assert.notEqual(next, w.old);
    assert.equal(git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]), w.old);
    const retained = relocate(w);
    assert.throws(() => reopen(w), DIVERGED);
    // Failed checkout selection creates no status and must be preserved too.
    const failed = paths.jobCheckout(w.cfg, ISSUE, "merge");
    fs.renameSync(failed, `${failed}-selection-failed`);
    assert.equal(
      fs.existsSync(path.join(paths.runDir(w.cfg, ISSUE), "job.json")),
      false,
    );

    const req = { number: ISSUE, id, lane: "L", retained };
    const first = reconcileWikiSync(w.scoped, req);
    assert.equal(first.adopted, true);
    let expectedResponse = "acknowledged";
    if (phase === "lost response") {
      expectedResponse = "lost";
    }
    assert.equal(first.response, expectedResponse);
    assert.deepEqual(reconcileWikiSync(w.scoped, req), first);
    const opened = reopen(w);
    assert.equal(headOf(opened.docs ?? ""), next);
    assert.equal(git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]), w.old);
    assert.deepEqual(
      fs.readFileSync(path.join(folder, "intent.json")),
      intentBytes,
    );
    assert.equal(
      recoveredWikiRevision(w.scoped, ISSUE, "L", {
        ...w.state.hardened,
        wiki: next,
      }),
      true,
    );
    assert.equal(w.state.integration, null);
    assert.equal(w.state.verifiedSha, null);
    assert.equal(w.state.security, null);
    assert.equal(git(w.wikiOrigin, ["rev-parse", "master"]), w.target);
  });
}

test("durable preservation failure prevents the wiki push", () => {
  const w = world();
  const prep = prepareWikiSync(w.scoped, ISSUE, w.dirs.docs, IDENTITY);
  git(w.dirs.docs, ["rebase", "origin/master"], COMMIT_ENV);
  const { folder } = checkpoint(w);
  fs.mkdirSync(path.join(folder, "after.bundle"));
  assert.throws(() => pushSyncedWiki(w.scoped, ISSUE, w.dirs.docs, prep));
  assert.equal(git(w.wikiOrigin, ["rev-parse", BRANCH]), w.old);
  assert.equal(fs.existsSync(path.join(folder, "intent.json")), false);
  assert.equal(fs.existsSync(path.join(folder, "before.bundle")), true);
  assert.throws(() => pushWikiBranch(w.scoped, ISSUE), REFUSED);
});

for (const observation of ["old", "different", "unreadable", "conflicting"]) {
  test(`uncertain push with ${observation} evidence stays unresolved and never resends`, () => {
    const w = world();
    const { id, folder } = synced(w);
    fs.unlinkSync(path.join(folder, "completion.json"));
    if (observation === "old") {
      git(w.wikiOrigin, ["update-ref", `refs/heads/${BRANCH}`, w.old]);
    }
    if (observation === "different") {
      git(w.wikiOrigin, ["update-ref", `refs/heads/${BRANCH}`, w.target]);
    }
    if (observation === "unreadable") {
      fs.renameSync(w.wikiOrigin, `${w.wikiOrigin}-offline`);
    }
    if (observation === "conflicting") {
      fs.writeFileSync(
        path.join(folder, "completion.json"),
        JSON.stringify({ id, new: w.old, response: "acknowledged" }),
      );
    }
    assert.throws(() => reconcile(w, id), REFUSED);
    assert.equal(fs.existsSync(path.join(folder, "selection.json")), false);
    assert.throws(() => pushWikiBranch(w.scoped, ISSUE), UNCERTAIN);
    assert.equal(
      headOf(w.dirs.docs),
      JSON.parse(fs.readFileSync(path.join(folder, "intent.json"), "utf8")).new,
    );
  });
}

for (const invalid of [
  "repo",
  "remote",
  "branch",
  "issue",
  "lane",
  "malformed",
  "malformed authority",
  "extra destination",
  "missing",
  "revoked",
  "inputs",
  "claim",
  "security",
]) {
  test(`${invalid} evidence cannot explain divergent histories`, () => {
    const w = world();
    const { id, folder } = synced(w);
    const file = path.join(folder, "preparation.json");
    const prep = JSON.parse(fs.readFileSync(file, "utf8"));
    if (["repo", "remote", "branch", "lane"].includes(invalid)) {
      prep[invalid] = "different";
    }
    if (invalid === "issue") {
      prep.issue = OTHER_ISSUE;
    }
    if (invalid === "malformed authority") {
      prep.authority.security = undefined;
    }
    if (invalid === "extra destination") {
      git(paths.wikiMirror(w.cfg), [
        "config",
        "--add",
        "remote.origin.pushurl",
        w.remote,
      ]);
      git(paths.wikiMirror(w.cfg), [
        "config",
        "--add",
        "remote.origin.pushurl",
        w.wikiOrigin,
      ]);
    }
    fs.writeFileSync(file, JSON.stringify(prep));
    if (invalid === "malformed") {
      fs.writeFileSync(file, "{broken");
    }
    if (invalid === "missing") {
      fs.renameSync(file, `${file}.retained`);
    }
    if (invalid === "revoked") {
      saveAuthority(w.cfg, { ...w.state, hardened: null });
    }
    if (invalid === "inputs") {
      saveIssueAuthority(w.cfg, {
        ...SOURCE_ISSUE,
        body: "Changed trusted requirements",
      });
    }
    if (invalid === "claim") {
      saveAuthority(w.cfg, {
        ...w.state,
        lease: { ...w.state.lease, lane: "other" },
      });
    }
    if (invalid === "security") {
      saveAuthority(w.cfg, {
        ...w.state,
        security: {
          revision: w.state.hardened,
          commentId: 44,
          finding: { category: "abuse-risk", reason: "Rejected" },
        },
      });
    }
    assert.throws(() => reconcile(w, id), REFUSED);
    assert.equal(git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]), w.old);
    relocate(w);
    assert.throws(() => reopen(w), DIVERGED);
  });
}

for (const extra of [
  "private commit",
  "retained commit",
  "staged and working files",
]) {
  test(`additional ${extra} are preserved and block adoption`, () => {
    const w = world();
    const { id, next } = synced(w);
    if (extra === "private commit") {
      git(paths.wikiMirror(w.cfg), [
        "fetch",
        w.dirs.docs,
        `+HEAD:refs/heads/${BRANCH}`,
      ]);
    }
    write(w.dirs.docs, "Unique.md", "staged unique work\n");
    git(w.dirs.docs, ["add", "Unique.md"]);
    if (extra === "staged and working files") {
      write(w.dirs.docs, "Unique.md", "working unique work\n");
    } else {
      git(w.dirs.docs, ["commit", "-m", "Unique work"], COMMIT_ENV);
    }
    if (extra === "private commit") {
      git(paths.wikiMirror(w.cfg), [
        "fetch",
        w.dirs.docs,
        `+HEAD:refs/heads/${BRANCH}`,
      ]);
    }
    const before = headOf(w.dirs.docs);
    assert.throws(() => reconcile(w, id), REFUSED);
    assert.equal(headOf(w.dirs.docs), before);
    assert.equal(fs.existsSync(path.join(w.dirs.docs, "Unique.md")), true);
    assert.equal(git(w.wikiOrigin, ["rev-parse", BRANCH]), next);
  });
}
