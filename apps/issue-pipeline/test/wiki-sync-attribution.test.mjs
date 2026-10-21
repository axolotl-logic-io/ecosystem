// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { git, headOf, ISSUE, write } from "./pipeline-commit-test-kit.mjs";
import {
  BRANCH,
  COMMIT_ENV,
  IDENTITY,
  paths,
  reconcile,
  relocate,
  reopen,
  synced,
  world,
} from "./wiki-sync-test-kit.mjs";
import { saveAuthority } from "./write-authority-test-kit.mjs";

const { syncWiki } = await import("../src/wiki-publish.ts");
const { reconcileWikiSync } = await import("../src/wiki-sync/reconcile.ts");
const REFUSED = /authorization|conflict|additional|reconciliation/u;
const NO_MUTATIONS = /no queued comments or checkout override/u;
const COMMAND_MS = 30_000;

/** @param {ReturnType<typeof world>} w @param {object} extra */
function recoveryOp(w, extra) {
  const child = spawnSync(
    process.execPath,
    [path.resolve(import.meta.dirname, "../dist/ops.mjs")],
    {
      input: `BEGIN_OPS_REQUEST\n${JSON.stringify({
        config: path.join(w.tmp, "config.json"),
        op: "reconcile-wiki-sync",
        number: ISSUE,
        branch: BRANCH,
        lane: "L",
        ...extra,
      })}\nEND_OPS_REQUEST\n`,
      encoding: "utf8",
      timeout: COMMAND_MS,
    },
  );
  if (child.status !== 0) {
    throw new Error(`recovery command failed: ${child.stderr}`);
  }
  return JSON.parse(child.stdout);
}

test("the explicit credentialed operation reconciles a relocated checkout before any replacement status exists", () => {
  const w = world();
  const { id, next } = synced(w);
  const retained = relocate(w);
  const result = recoveryOp(w, { id, retained });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.adopted, true);
  assert.equal(result.posted, 0);
  assert.equal(
    fs.existsSync(path.join(paths.runDir(w.cfg, ISSUE), "job.json")),
    false,
  );
  const opened = reopen(w);
  assert.equal(headOf(opened.docs ?? ""), next);
});

test("recovery refuses queued mutations and checkout overrides rather than posting them before a read-only reconciliation", () => {
  const w = world();
  const { id } = synced(w);
  for (const extra of [
    {
      comments: [{ number: ISSUE, role: "coordinator", body: "must not post" }],
    },
    { checkout: { issue: ISSUE, dir: w.dirs.repo, branch: BRANCH } },
  ]) {
    const reply = recoveryOp(w, { id, retained: w.dirs.docs, ...extra });
    assert.equal(reply.ok, false);
    assert.match(reply.error, NO_MUTATIONS);
  }
});

test("sync cannot bind unauthorized source work to otherwise valid saved authority", () => {
  const w = world();
  write(w.dirs.docs, "Unauthorized.md", "not the saved revision\n");
  git(w.dirs.docs, ["add", "Unauthorized.md"]);
  git(w.dirs.docs, ["commit", "-m", "Unreviewed source"], COMMIT_ENV);
  assert.throws(() => syncWiki(w.scoped, ISSUE, IDENTITY), REFUSED);
  assert.equal(git(w.wikiOrigin, ["rev-parse", BRANCH]), w.old);
});

test("a different clean retained checkout cannot hide staged work in the still-present original", () => {
  const w = world();
  const { id } = synced(w);
  const shadow = path.join(w.tmp, "clean-shadow");
  git(w.tmp, ["clone", "--branch", BRANCH, w.remote, shadow]);
  write(w.dirs.docs, "Private.md", "staged evidence\n");
  git(w.dirs.docs, ["add", "Private.md"]);
  write(w.dirs.docs, "Private.md", "working evidence\n");
  assert.throws(
    () =>
      reconcileWikiSync(w.scoped, {
        number: ISSUE,
        id,
        lane: "L",
        retained: shadow,
      }),
    REFUSED,
  );
  assert.equal(
    fs.readFileSync(path.join(w.dirs.docs, "Private.md"), "utf8"),
    "working evidence\n",
  );
  assert.equal(git(w.dirs.docs, ["show", ":Private.md"]), "staged evidence");
});

test("a conflicting private-tip selection cannot bypass unique private commits", () => {
  const w = world();
  const { id, folder } = synced(w);
  reconcile(w, id);
  const tree = git(w.dirs.docs, ["rev-parse", `${w.old}^{tree}`]);
  const unique = git(
    w.dirs.docs,
    ["commit-tree", tree, "-p", w.old, "-m", "Private unique history"],
    COMMIT_ENV,
  );
  git(paths.wikiMirror(w.cfg), [
    "fetch",
    w.dirs.docs,
    `+${unique}:refs/heads/${BRANCH}`,
  ]);
  const file = path.join(folder, "selection.json");
  const selection = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...selection, private: unique }));
  relocate(w);
  assert.throws(() => reopen(w), REFUSED);
  assert.equal(git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]), unique);
});

test("later conflicting attribution invalidates an earlier local selection", () => {
  const w = world();
  const { id, folder } = synced(w);
  reconcile(w, id);
  const other = randomUUID();
  const duplicate = path.join(path.dirname(folder), other);
  fs.mkdirSync(duplicate);
  for (const name of ["preparation", "intent", "completion"]) {
    const value = JSON.parse(
      fs.readFileSync(path.join(folder, `${name}.json`), "utf8"),
    );
    fs.writeFileSync(
      path.join(duplicate, `${name}.json`),
      JSON.stringify({ ...value, id: other }),
    );
  }
  relocate(w);
  assert.throws(() => reopen(w), REFUSED);
  assert.equal(git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]), w.old);
});

test("a saved exact integration can survive interruption before private mirror catch-up without replacing original hardening", () => {
  const w = world();
  const { id, next } = synced(w);
  reconcile(w, id);
  const integration = {
    reviewed: w.state.hardened,
    revision: { ...w.state.hardened, wiki: next },
  };
  saveAuthority(w.cfg, { ...w.state, integration });
  relocate(w);
  const opened = reopen(w);
  assert.equal(headOf(opened.docs ?? ""), next);
  assert.equal(git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]), w.old);
});
