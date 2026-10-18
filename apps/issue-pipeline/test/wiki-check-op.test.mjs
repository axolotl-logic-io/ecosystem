// @ts-check
// The wiki-check op (#215) against a real wiki checkout: issue #7's committed
// wiki pages compared with the wiki's master on origin, in-process and through
// the ops CLI.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { configFixture } from "./config-fixtures.mjs";
import { opsFixture } from "./ops-fixture.mjs";

const fx = await opsFixture("wiki-check");
const { wikiCheck } = await import("../src/ops/wiki-check.ts");

const ISSUE = 7;
const GIT_USER = "-c user.email=a@b -c user.name=a";
const CFG = configFixture({ account: "a", allowedUsers: ["a"], leaseHours: 1 });
const WIKI_CFG = configFixture({
  account: "a",
  allowedUsers: ["a"],
  leaseHours: 1,
  wiki: true,
});
const BAD_REQUEST = /bad wiki-check request/u;
const CLEAN = { checks: [], pass: true };

// A bare wiki origin on master with Home and _Sidebar, cloned as issue #7's
// wiki checkout so that origin/master exists. Returns the checkout.
/** @returns {string} */
function wikiCheckout() {
  const origin = path.join(fx.root, "wiki.git");
  const dir = path.join(fx.worktree(ISSUE), "wiki");
  fs.rmSync(origin, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(fx.worktree(ISSUE), { recursive: true });
  fx.sh(`git init -q --bare -b master ${origin}`);
  fx.sh(`git clone -q ${origin} ${dir} 2>/dev/null`);
  commitPages(dir, {
    "Home.md": "Welcome.",
    "_Sidebar.md": "- [[Home]]",
  });
  fx.sh(`git -C ${dir} push -q origin HEAD:master`);
  return dir;
}

// Writes and commits pages in the checkout, which then is ahead of master.
/**
 * @param {string} dir
 * @param {Record<string, string>} pages
 * @returns {void}
 */
function commitPages(dir, pages) {
  for (const [file, text] of Object.entries(pages)) {
    fs.writeFileSync(path.join(dir, file), `${text}\n`);
  }
  fx.sh(`git -C ${dir} add -A && git -C ${dir} ${GIT_USER} commit -qm pages`);
}

// Each check as { id, pass }, and whether its detail names every word given
// for it in `names`.
/**
 * @param {{ pass: boolean, checks: { id: string, pass: boolean, detail: string }[] }} reply
 * @param {Record<string, string[]>} names
 * @returns {{ pass: boolean, checks: { id: string, pass: boolean, named: boolean }[] }}
 */
function checked({ pass, checks }, names) {
  return {
    pass,
    checks: checks.map(({ id, pass: ok, detail }) => ({
      id,
      pass: ok,
      named: (names[id] ?? []).every((name) => detail.includes(name)),
    })),
  };
}

test("a new orphan page and a broken link fail until they are fixed", () => {
  const dir = wikiCheckout();
  commitPages(dir, { "New-Page.md": "See [[Missing Page]] and [[Home]]." });
  const names = {
    "wiki-link:New-Page:Missing Page": ["New-Page", "Missing Page"],
    "wiki-orphan:New-Page": ["New-Page", "_Sidebar"],
  };
  assert.deepEqual(checked(wikiCheck(WIKI_CFG, { number: ISSUE }), names), {
    pass: false,
    checks: [
      { id: "wiki-link:New-Page:Missing Page", pass: false, named: true },
      { id: "wiki-orphan:New-Page", pass: false, named: true },
    ],
  });
  commitPages(dir, {
    "New-Page.md": "See [[Home]].",
    "_Sidebar.md": "- [[Home]]\n- [[New Page]]",
  });
  assert.deepEqual(wikiCheck(WIKI_CFG, { number: ISSUE }), CLEAN);
});

test("a committed change to an existing page is checked", () => {
  const dir = wikiCheckout();
  commitPages(dir, { "Home.md": "Welcome. See [[Missing Page]]." });
  const names = { "wiki-link:Home:Missing Page": ["Home", "Missing Page"] };
  assert.deepEqual(checked(wikiCheck(WIKI_CFG, { number: ISSUE }), names), {
    pass: false,
    checks: [{ id: "wiki-link:Home:Missing Page", pass: false, named: true }],
  });
});

// Home is a modified page, which the test above shows is checked, so a clean
// reply means the working tree's edit was not read.
test("uncommitted edits are ignored", () => {
  const dir = wikiCheckout();
  commitPages(dir, { "Home.md": "Welcome to [[Home]]." });
  fs.writeFileSync(path.join(dir, "Home.md"), "[[Uncommitted Nope]]\n");
  assert.deepEqual(wikiCheck(WIKI_CFG, { number: ISSUE }), CLEAN);
});

test("no wiki, or no commits ahead of it, is nothing to check", () => {
  const dir = wikiCheckout();
  assert.deepEqual(wikiCheck(WIKI_CFG, { number: ISSUE }), CLEAN);
  commitPages(dir, { "Home.md": "[[Missing Page]]" });
  assert.deepEqual(wikiCheck(CFG, { number: ISSUE }), CLEAN);
});

test("the ops CLI runs wiki-check and rejects a request with no number", () => {
  assert.deepEqual(JSON.parse(fx.ask({ op: "wiki-check", number: ISSUE })), {
    ok: true,
    op: "wiki-check",
    posted: 0,
    commentIds: [],
    ...CLEAN,
  });
  const bad = JSON.parse(fx.ask({ op: "wiki-check" }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, BAD_REQUEST);
});
