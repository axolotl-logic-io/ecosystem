// @ts-check
// A code checkout's wiki gitlink as #420's branch left it (#458): the wiki
// checkout ahead of the code branch's pin on a commit of its own, as an
// issue's wiki branch is, and code commits that move the pin and put it
// back. A rebase, reset or checkout that replays those commits writes the
// gitlink's index entry anew, which drops its assume-unchanged mark.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { addSubmodule } from "./submodule-test-kit.mjs";

/** @import { OpsFixture } from "./ops-fixture.mjs" */

// Commits made outside a job need a name and no signing, and a job
// checkout's pre-commit hook passes only commits that say so.
const IDENTITY = [
  "-c",
  "user.name=Seed",
  "-c",
  "user.email=seed@example.com",
  "-c",
  "commit.gpgsign=false",
];
const COMMIT_ENV = {
  ...process.env,
  ...Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]),
};

/** @param {string} dir @param {readonly string[]} args @returns {string} git's trimmed stdout */
function git(dir, args) {
  return execFileSync("git", [...IDENTITY, "-C", dir, ...args], {
    encoding: "utf8",
    env: COMMIT_ENV,
  }).trim();
}

/**
 * Gives `fx`'s base a `wiki` submodule of a local wiki origin with one page,
 * and brings the pipeline's clone onto it.
 * @param {OpsFixture} fx
 * @returns {void}
 */
function addWiki(fx) {
  const { root, sh } = fx;
  const wikiOrigin = path.join(root, "wiki.git");
  const wikiSeed = path.join(root, "wiki-seed");
  sh(`git init -q --bare -b master ${wikiOrigin}`);
  sh(`git clone -q ${wikiOrigin} ${wikiSeed} 2>/dev/null`);
  sh(`cd ${wikiSeed} && git config user.email a@b && git config user.name a`);
  sh(
    `cd ${wikiSeed} && echo home > Home.md && git add . && git commit -qm home`,
  );
  sh(`cd ${wikiSeed} && git push -q origin HEAD:master`);
  addSubmodule(path.join(root, "seed"), wikiOrigin);
  sh(`git -C ${root}/seed push -q origin integration`);
  fx.fetchClone();
  sh(`git -C ${root}/clones/o__r reset --hard origin/integration`);
}

/**
 * Commits `page` in `wt`'s wiki checkout, so its head is ahead of the pin.
 * @param {string} wt
 * @param {string} page
 * @returns {string} the wiki checkout's new head
 */
function wikiAhead(wt, page) {
  const wiki = path.join(wt, "wiki");
  fs.writeFileSync(path.join(wiki, `${page}.md`), `${page}\n`);
  git(wiki, ["add", `${page}.md`]);
  git(wiki, ["commit", "--quiet", "-m", page]);
  return git(wiki, ["rev-parse", "HEAD"]);
}

/**
 * Commits in `wt` a move of the wiki pin to the wiki checkout's head, on
 * purpose: the mark cleared first, as the README says, and set again after.
 * @param {string} wt
 * @returns {void}
 */
function movePin(wt) {
  git(wt, ["update-index", "--no-assume-unchanged", "--", "wiki"]);
  git(wt, ["add", "wiki"]);
  git(wt, ["commit", "--quiet", "-m", "move the wiki pin"]);
  git(wt, ["update-index", "--assume-unchanged", "--", "wiki"]);
}

/**
 * Commits in `wt` a move of the wiki pin to the wiki checkout's head, then
 * one that puts the pin back, and leaves the wiki checkout ahead again with
 * the gitlink marked assume-unchanged, as a pipeline checkout has it.
 * @param {string} wt
 * @returns {void}
 */
function movePinAndBack(wt) {
  const wiki = path.join(wt, "wiki");
  const pin = git(wt, ["rev-parse", "HEAD:wiki"]);
  movePin(wt);
  git(wiki, ["checkout", "--quiet", "--detach", pin]);
  git(wt, ["update-index", "--no-assume-unchanged", "--", "wiki"]);
  git(wt, ["add", "wiki"]);
  git(wt, ["commit", "--quiet", "-m", "put back the wiki pin"]);
  git(wiki, ["checkout", "--quiet", "-"]);
  git(wt, ["update-index", "--assume-unchanged", "--", "wiki"]);
}

/**
 * Resets `wt` to the commit before its head and back, as a writer's own
 * reset might; when that commit pins another wiki commit, git writes the
 * gitlink's entry anew and drops its mark.
 * @param {string} wt
 * @returns {void}
 */
function resetAcrossPin(wt) {
  const head = git(wt, ["rev-parse", "HEAD"]);
  git(wt, ["reset", "--quiet", "--hard", "HEAD~1"]);
  git(wt, ["reset", "--quiet", "--hard", head]);
}

/**
 * Rebases `wt`'s last two commits, which move the wiki pin and put it back,
 * onto the commit before them again, replaying them as a sync's rebase does.
 * @param {string} wt
 * @returns {void}
 */
function rebaseAcrossPin(wt) {
  git(wt, ["rebase", "--quiet", "--force-rebase", "HEAD~2"]);
}

/** @param {string} wt @returns {string} `git status --porcelain` in `wt` */
function statusOf(wt) {
  return git(wt, ["status", "--porcelain"]);
}

/** @param {string} dir @param {string} rev @returns {string} the wiki commit `rev` pins in `dir` */
function pinAt(dir, rev) {
  return git(dir, ["rev-parse", `${rev}:wiki`]);
}

export {
  addWiki,
  movePin,
  movePinAndBack,
  pinAt,
  rebaseAcrossPin,
  resetAcrossPin,
  statusOf,
  wikiAhead,
};
