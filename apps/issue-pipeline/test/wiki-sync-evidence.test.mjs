// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { git, headOf, ISSUE, write } from "./pipeline-commit-test-kit.mjs";
import {
  BRANCH,
  paths,
  reconcile,
  relocate,
  reopen,
  synced,
  world,
} from "./wiki-sync-test-kit.mjs";

const { pushWikiBranch } = await import("../src/wiki.ts");
const REFUSED = /conflict|additional|reconciliation/u;
const REPLACED = /retained wiki checkout identity changed/u;

/** @param {ReturnType<typeof world>} w @param {string} id @param {string} phase */
function recoveryAttempt(w, id, phase) {
  if (phase === "checkout selection") {
    return { retained: w.dirs.docs, run: () => reopen(w) };
  }
  return { retained: w.dirs.docs, run: () => reconcile(w, id) };
}

for (const phase of ["reconciliation", "checkout selection"]) {
  test(`stashed index and working edits block ${phase} without losing either version`, () => {
    const w = world();
    const { id, next, folder } = synced(w);
    const preserved = { ...w, dirs: { ...w.dirs, docs: relocate(w) } };
    if (phase === "checkout selection") {
      reconcile(preserved, id);
    }
    write(preserved.dirs.docs, "Issue.md", "staged unique edits\n");
    git(preserved.dirs.docs, ["add", "Issue.md"]);
    write(preserved.dirs.docs, "Issue.md", "working unique edits\n");
    git(preserved.dirs.docs, ["stash", "push", "-m", "Retained recovery work"]);
    const stash = git(preserved.dirs.docs, ["rev-parse", "refs/stash"]);
    assert.equal(git(preserved.dirs.docs, ["status", "--porcelain"]), "");
    const { retained, run } = recoveryAttempt(preserved, id, phase);
    assert.throws(run, REFUSED);
    assert.equal(
      fs.existsSync(path.join(folder, "selection.json")),
      phase === "checkout selection",
    );
    assert.equal(headOf(retained), next);
    assert.equal(git(retained, ["rev-parse", "refs/stash"]), stash);
    assert.equal(
      git(retained, ["show", "stash:Issue.md"]),
      "working unique edits",
    );
    assert.equal(
      git(retained, ["show", "stash^2:Issue.md"]),
      "staged unique edits",
    );
    assert.equal(git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]), w.old);
    assert.equal(git(w.wikiOrigin, ["rev-parse", BRANCH]), next);
  });

  test(`contradictory abandonment blocks ${phase} and ordinary wiki pushes`, () => {
    const w = world();
    const { id, next, folder } = synced(w);
    const preserved = { ...w, dirs: { ...w.dirs, docs: relocate(w) } };
    if (phase === "checkout selection") {
      reconcile(preserved, id);
    }
    const intent = fs.readFileSync(path.join(folder, "intent.json"));
    fs.writeFileSync(
      path.join(folder, "abandoned.json"),
      JSON.stringify({ id }),
    );
    const { run } = recoveryAttempt(preserved, id, phase);
    assert.throws(run, REFUSED);
    assert.equal(
      fs.existsSync(path.join(folder, "selection.json")),
      phase === "checkout selection",
    );
    assert.throws(() => pushWikiBranch(w.scoped, ISSUE), REFUSED);
    assert.deepEqual(fs.readFileSync(path.join(folder, "intent.json")), intent);
    assert.equal(git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]), w.old);
    assert.equal(git(w.wikiOrigin, ["rev-parse", BRANCH]), next);
  });
}

test("a replacement checkout at a selected path cannot stand in for relocated evidence", () => {
  const w = world();
  const { id, next, folder } = synced(w);
  reconcile(w, id);
  const selection = fs.readFileSync(path.join(folder, "selection.json"));
  write(w.dirs.docs, "Private.md", "private staged edits after selection\n");
  git(w.dirs.docs, ["add", "Private.md"]);
  write(w.dirs.docs, "Private.md", "private working edits after selection\n");
  const retained = relocate(w);
  assert.throws(() => reopen(w), REPLACED);
  assert.equal(
    fs.readFileSync(path.join(retained, "Private.md"), "utf8"),
    "private working edits after selection\n",
  );
  assert.equal(
    git(retained, ["show", ":Private.md"]),
    "private staged edits after selection",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(folder, "selection.json")),
    selection,
  );
  assert.equal(git(paths.wikiMirror(w.cfg), ["rev-parse", BRANCH]), w.old);
  assert.equal(git(w.wikiOrigin, ["rev-parse", BRANCH]), next);
});
