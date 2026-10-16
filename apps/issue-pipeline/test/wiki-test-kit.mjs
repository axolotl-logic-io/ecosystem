// @ts-check
// An issue's wiki as ensureWiki leaves it, for the tests of the wiki's
// rebase and publish: a bare wiki origin, the shared wiki clone, and #7's wiki
// checkout with one commit of its own.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { GIT_USER, sh } from "./ops-test-kit.mjs";

/** @import { World } from "./ops-test-kit.mjs" */

// Turns the wiki on and sets it up as ensureWiki does: a bare wiki origin, the
// shared wiki clone, and #7's wiki checkout one commit ahead, that edits
// Home.md's line and is kept on origin's agent/issue-7. A conflict gives
// origin's master its own edit of that line; a rejecting origin then refuses
// every push. Returns the wiki origin and the issue's commit.
/** @param {World} w @param {{ conflict?: boolean, rejectPushes?: boolean }} [options] @returns {{ origin: string, sha: string }} */
function withWiki(w, { conflict = false, rejectPushes = false } = {}) {
  const origin = path.join(w.root, "wiki.git");
  const clone = path.join(w.root, "clones/o__r.wiki");
  const dir = path.join(w.worktree, "wiki");
  const config = z
    .looseObject({})
    .parse(JSON.parse(fs.readFileSync(w.config, "utf8")));
  fs.writeFileSync(w.config, JSON.stringify({ ...config, wiki: true }));
  sh(
    `cd ${w.root} && git init -q --bare -b master wiki.git && git clone -q wiki.git ${clone} 2>/dev/null && echo home > ${clone}/Home.md && git -C ${clone} add Home.md && git -C ${clone} ${GIT_USER} commit -q -m home && git -C ${clone} push -q origin HEAD:master`,
  );
  sh(
    `git -C ${clone} worktree add -q -b agent/issue-7 ${dir} origin/master && echo issue > ${dir}/Home.md && git -C ${dir} ${GIT_USER} commit -q -am page && git -C ${dir} push -q origin HEAD:agent/issue-7`,
  );
  if (conflict) {
    const other = path.join(w.root, "wiki-other");
    sh(
      `git clone -q ${origin} ${other} 2>/dev/null && echo other > ${other}/Home.md && git -C ${other} ${GIT_USER} commit -q -am other && git -C ${other} push -q origin HEAD:master`,
    );
  }
  if (rejectPushes) {
    fs.writeFileSync(
      path.join(origin, "hooks/pre-receive"),
      "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );
  }
  return { origin, sha: sh(`git -C ${dir} rev-parse HEAD`) };
}

// True when the wiki origin has a branch named `name`.
/** @param {string} origin @param {string} name @returns {boolean} */
function hasBranch(origin, name) {
  return sh(`git -C ${origin} branch --list ${name}`) !== "";
}

export { hasBranch, withWiki };
