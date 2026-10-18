// The issue's wiki branch on the wiki remote (agent/issue-<n>): push sends the
// wiki checkout's own commits there, ensureWiki rebuilds a checkout from it,
// and wikiBranchHasWork says whether it holds commits the wiki lacks.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { initialWriteStateReply } from "./initial-write-state-fixtures.mjs";
import { okLine, opsFixture, stateReadCall } from "./ops-fixture.mjs";
import { addSubmodule } from "./submodule-test-kit.mjs";

const fx = await opsFixture("wiki-branch");
const { sh } = fx;
const { loadConfig } = await import("../src/config.ts");
const { ensureWiki, wikiBranchHasWork } = await import("../src/wiki.ts");
const { ensureClone, ensureWorktree } = await import("../src/checkouts.ts");
const { ghIsRead } = await import("../src/github.ts");

const wikiOrigin = path.join(fx.root, "wiki.git");
const seed = path.join(fx.root, "wiki-seed");
sh(`git init -q --bare -b master ${wikiOrigin}`);
sh(`git clone -q ${wikiOrigin} ${seed} 2>/dev/null`);
sh(`cd ${seed} && git config user.email a@b && git config user.name a`);
sh(`cd ${seed} && echo home > Home.md && git add . && git commit -qm home`);
sh(`cd ${seed} && git push -q origin HEAD:master && git fetch -q origin`);
addSubmodule(path.join(fx.root, "seed"), wikiOrigin);
sh(`git -C ${fx.root}/seed push -q origin integration`);
fx.fetchClone();
sh(`git -C ${fx.root}/clones/o__r reset --hard origin/integration`);
const config = fx.configWith("wiki-config.json", { wiki: true });
const cfg = loadConfig(config);
ensureClone(cfg);
const noWiki = loadConfig(path.join(fx.root, "config.json"));
// One issue per test, so no test sees another's branches.
const PUSHED = 1;
const UNPUSHED = 2;
const FRESH = 3;
const MOVED = 4;
const WITH_WORK = 5;
const NO_BRANCH = 6;
const AT_MASTER = 7;
const WIKI_ONLY_PUSH = 8;
const WIKI_ONLY_PR = { n: 9, pr: 69 };
const DIRTY = 10;
const LOCAL_WORK = 11;
const PIN_UPDATE = 12;
const CODE_COMMIT = 13;

// The sha of a ref on the wiki origin, or "" when it has none.
/** @param {string} ref @returns {string} */
function wikiRef(ref) {
  return sh(`git --git-dir ${wikiOrigin} rev-parse -q --verify ${ref} || true`);
}

// Issue `n`'s wiki checkout, which the wiki-on config always has.
/** @param {number} n @returns {string} */
function wikiOf(n) {
  ensureWorktree(cfg, n);
  const dir = ensureWiki(cfg, n);
  if (dir === null) {
    throw new Error("no wiki checkout");
  }
  return dir;
}

/** @param {string} dir @returns {string} */
function headOf(dir) {
  return sh(`git -C ${dir} rev-parse HEAD`);
}

// Pushes one commit of `page` on the wiki's master to the wiki's
// agent/issue-<n>, as another lane would have; returns its sha.
/** @param {number} n @param {string} page @returns {string} */
function seedWikiBranch(n, page) {
  sh(`cd ${seed} && git checkout -q -B agent/issue-${n} origin/master`);
  sh(
    `cd ${seed} && echo ${page} > ${page}.md && git add . && git commit -qm ${page}`,
  );
  sh(`cd ${seed} && git push -q origin HEAD:agent/issue-${n}`);
  return wikiRef(`agent/issue-${n}`);
}

// Runs the push op for issue `n` with the wiki on, whose branch changes code
// and whose wiki checkout has `wikiAhead` commits of its own. Returns its
// stdout, what it should be, and the gh calls it made.
/** @param {number} n @param {number} wikiAhead */
function pushOp(n, wikiAhead) {
  fx.fakeGh.reply([initialWriteStateReply(n)]);
  const out = fx.ask({ op: "push", number: n }, config);
  const headSha = fx.originRef(`agent/issue-${n}`);
  const want = okLine("push", { headSha, codeChanged: true, wikiAhead });
  return { out, want, ghCalls: fx.fakeGh.calls() };
}

test("push sends the issue's wiki commits to its wiki branch", () => {
  fx.startBranch(PUSHED, "g", "one");
  const master = wikiRef("master");
  const dir = wikiOf(PUSHED);
  sh(`cd ${dir} && echo page > Page.md && git add . && git commit -qm page`);
  const { out, want, ghCalls } = pushOp(PUSHED, 1);
  assert.equal(out, want);
  assert.deepEqual(ghCalls, [stateReadCall(PUSHED)]);
  assert.equal(wikiRef(`agent/issue-${PUSHED}`), headOf(dir));
  assert.equal(wikiRef("master"), master);
});

test("push leaves the wiki origin alone when the wiki has no commits of its own", () => {
  fx.startBranch(UNPUSHED, "g", "two");
  ensureWiki(cfg, UNPUSHED);
  const before = sh(`git ls-remote ${wikiOrigin}`);
  const { out, want } = pushOp(UNPUSHED, 0);
  assert.equal(out, want);
  assert.equal(sh(`git ls-remote ${wikiOrigin}`), before);
});

test("a fresh lane builds the wiki checkout from the wiki branch", () => {
  const sha = seedWikiBranch(FRESH, "Three");
  const dir = wikiOf(FRESH);
  assert.equal(headOf(dir), sha);
});

test("a clean checkout with nothing of its own moves to the wiki branch", () => {
  const dir = wikiOf(MOVED);
  assert.equal(headOf(dir), wikiRef("master"));
  const sha = seedWikiBranch(MOVED, "Four");
  assert.equal(ensureWiki(cfg, MOVED), dir);
  assert.equal(headOf(dir), sha);
});

test("wikiBranchHasWork", () => {
  seedWikiBranch(WITH_WORK, "Five");
  const atMaster = `origin/master:refs/heads/agent/issue-${AT_MASTER}`;
  sh(`cd ${seed} && git push -q origin ${atMaster}`);
  assert.equal(wikiBranchHasWork(cfg, WITH_WORK), true);
  assert.equal(wikiBranchHasWork(cfg, NO_BRANCH), false);
  assert.equal(wikiBranchHasWork(cfg, AT_MASTER), false);
  assert.equal(wikiBranchHasWork(noWiki, WITH_WORK), false);
});

test("uncommitted wiki edits still refuse a code push", () => {
  fx.startBranch(DIRTY, "g", "dirty");
  const dir = wikiOf(DIRTY);
  sh(`echo unstaged > ${dir}/Unstaged.md`);
  fx.fakeGh.reply([initialWriteStateReply(DIRTY)]);
  const out = JSON.parse(fx.ask({ op: "push", number: DIRTY }, config));
  assert.equal(out.ok, false);
  assert.ok(
    String(out.error).includes("the wiki checkout has uncommitted changes"),
  );
  assert.equal(wikiRef(`agent/issue-${DIRTY}`), "");
});

test("another claim preserves unpublished wiki commits and uncommitted pages", () => {
  const dir = wikiOf(LOCAL_WORK);
  sh(`cd ${dir} && echo page > Local.md && git add . && git commit -qm local`);
  const sha = headOf(dir);
  sh(`echo unstaged > ${dir}/Unstaged.md`);
  ensureWorktree(cfg, LOCAL_WORK);
  assert.equal(ensureWiki(cfg, LOCAL_WORK), dir);
  assert.equal(headOf(dir), sha);
  assert.equal(sh(`git -C ${dir} status --porcelain`), "?? Unstaged.md");
});

// Gives issue `n` a code branch with only an empty commit and a wiki checkout
// with one commit of its own.
/** @param {number} n */
function wikiOnlyWork(n) {
  fx.fetchClone();
  const wt = ensureWorktree(cfg, n);
  sh(`git -C ${wt} commit -q --allow-empty -m start`);
  const dir = wikiOf(n);
  sh(`cd ${dir} && echo w > W${n}.md && git add . && git commit -qm w`);
  return { wt, dir };
}

test("push of a wiki-only change pushes both branches and says the code is unchanged", () => {
  const { wt, dir } = wikiOnlyWork(WIKI_ONLY_PUSH);
  fx.fakeGh.reply([initialWriteStateReply(WIKI_ONLY_PUSH)]);
  const out = fx.ask({ op: "push", number: WIKI_ONLY_PUSH }, config);
  const headSha = headOf(wt);
  const want = { headSha, codeChanged: false, wikiAhead: 1 };
  assert.equal(out, okLine("push", want));
  assert.equal(fx.originRef(`agent/issue-${WIKI_ONLY_PUSH}`), headSha);
  assert.equal(wikiRef(`agent/issue-${WIKI_ONLY_PUSH}`), headOf(dir));
});

test("git add -A of code leaves the separately edited wiki pin unchanged", () => {
  const { wt } = wikiOnlyWork(CODE_COMMIT);
  const pin = sh(`git -C ${wt} rev-parse HEAD:wiki`);
  sh(`cd ${wt} && echo code > code.txt && git add -A && git commit -qm code`);
  assert.equal(sh(`git -C ${wt} rev-parse HEAD:wiki`), pin);
  assert.equal(sh(`git -C ${wt}/wiki show HEAD:W${CODE_COMMIT}.md`), "w");
});

test("an explicitly committed wiki pin update is a code change", () => {
  const { wt } = wikiOnlyWork(PIN_UPDATE);
  sh(`git -C ${wt} update-index --no-assume-unchanged wiki`);
  sh(`git -C ${wt} add wiki && git -C ${wt} commit -qm pin`);
  fx.fakeGh.reply([initialWriteStateReply(PIN_UPDATE)]);
  const out = JSON.parse(fx.ask({ op: "push", number: PIN_UPDATE }, config));
  assert.equal(out.ok, true, out.error);
  assert.equal(out.codeChanged, true);
  assert.equal(out.wikiAhead, 1);
});

test("open-pr of a wiki-only change leaves the draft's title, body and draft status alone", () => {
  const { n, pr } = WIKI_ONLY_PR;
  const { wt } = wikiOnlyWork(n);
  fx.fakeGh.reply([
    initialWriteStateReply(n),
    { when: "pr list", stdout: `[{"number":${pr}}]` },
  ]);
  const out = fx.ask(
    { op: "open-pr", number: n, title: "T", body: "B" },
    config,
  );
  const want = { pr, headSha: headOf(wt), codeChanged: false, wikiAhead: 1 };
  assert.equal(out, okLine("open-pr", want));
  assert.deepEqual(
    fx.fakeGh.calls().filter((args) => !ghIsRead(args)),
    [],
  );
});
