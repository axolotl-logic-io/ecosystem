// The stop op during implement: the implementer's commits that exist only
// in the worktree (and the wiki checkout) reach the issue's branch on GitHub
// before the stop, and a failed push only adds a line to the stop comment
// (#283).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { bodyOf, effectNames } from "./gh-effects.mjs";
import {
  askOps,
  configWith,
  effects,
  reply,
  root,
  sh,
  worktree,
} from "./ops-cli-test-kit.mjs";

const COMMITTER = "-c user.email=a@b -c user.name=a";
const ORIGIN = `${root}/origin.git`;
// The issues: pushed, rejected by origin, stopped at review, and with a wiki.
const PUSHED = 60;
const REJECTED = 61;
const AT_REVIEW = 62;
const WITH_WIKI = 63;
const LABEL = "agent:stopped-too-large";
const ONLY_LOCAL = "only local";
// A hook's mode: executable by everyone, writable by its owner.
const EXECUTABLE = 0o755;

// A stop runs after a sweep, which made the clone.
sh(`git clone -q ${ORIGIN} ${root}/clones/o__r`);

// Makes origin reject every push to issue `n`'s branch from now on.
/** @param {number} n @returns {void} */
function rejectPushesTo(n) {
  const hook = path.join(ORIGIN, "hooks", "pre-receive");
  fs.writeFileSync(
    hook,
    `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/agent/issue-${n} ]; then exit 1; fi\ndone\n`,
  );
  fs.chmodSync(hook, EXECUTABLE);
}

// Gives issue `n` a branch on origin and a worktree with one commit on top
// of it. Returns the worktree's head.
/** @param {number} n @returns {string} */
function worktreeAheadOfBranch(n) {
  sh(
    `cd ${root}/seed && git checkout -qB agent/issue-${n} integration && echo ${n} > b-${n} && git add b-${n} && git commit -qm branch && git push -q origin HEAD:refs/heads/agent/issue-${n}`,
  );
  const clone = `${root}/clones/o__r`;
  sh(`git -C ${clone} fetch -q origin`);
  sh(
    `git -C ${clone} worktree add -q -B agent/issue-${n} ${worktree(n)} origin/agent/issue-${n}`,
  );
  sh(
    `cd ${worktree(n)} && echo mine > mine && git add mine && git ${COMMITTER} commit -qm mine`,
  );
  return sh(`git -C ${worktree(n)} rev-parse HEAD`);
}

/** @param {string} dir @param {string} branch @returns {string} */
function headOf(dir, branch) {
  return sh(`git -C ${dir} rev-parse refs/heads/${branch}`);
}

// Stops issue `n` at `stage` as too large; `extra` may name the config.
/** @param {number} n @param {string} stage @param {object} [extra] @returns {unknown} */
function stopAt(n, stage, extra = {}) {
  reply([]);
  return askOps({
    op: "stop",
    ...extra,
    number: n,
    code: "too-large",
    reason: "handed off twice",
    state: { stage },
  });
}

const STOP_REPLY = {
  ok: true,
  op: "stop",
  posted: 0,
  code: "too-large",
  label: LABEL,
};

test("a stop in implement pushes the worktree's commits to the branch", () => {
  const sha = worktreeAheadOfBranch(PUSHED);
  assert.deepEqual(stopAt(PUSHED, "implement"), STOP_REPLY);
  assert.equal(headOf(ORIGIN, `agent/issue-${PUSHED}`), sha);
  const body = bodyOf(effects(), `comment #${PUSHED} role=coordinator`);
  assert.equal(body.includes(ONLY_LOCAL), false);
});

test("a rejected push still stops, and the comment names the local head", () => {
  const sha = worktreeAheadOfBranch(REJECTED);
  rejectPushesTo(REJECTED);
  const before = headOf(ORIGIN, `agent/issue-${REJECTED}`);
  assert.deepEqual(stopAt(REJECTED, "implement"), STOP_REPLY);
  assert.equal(headOf(ORIGIN, `agent/issue-${REJECTED}`), before);
  const stopped = effects();
  assert.ok(effectNames(stopped).includes(`label #${REJECTED} ${LABEL}`));
  const body = bodyOf(stopped, `comment #${REJECTED} role=coordinator`);
  assert.ok(body.includes(sha) && body.includes(ONLY_LOCAL));
});

test("a stop at review pushes nothing", () => {
  worktreeAheadOfBranch(AT_REVIEW);
  const before = headOf(ORIGIN, `agent/issue-${AT_REVIEW}`);
  assert.deepEqual(stopAt(AT_REVIEW, "review"), STOP_REPLY);
  assert.equal(headOf(ORIGIN, `agent/issue-${AT_REVIEW}`), before);
});

test("a stop in implement pushes the wiki checkout's commits", () => {
  const wikiOrigin = path.join(root, "wiki.git");
  const wiki = path.join(worktree(WITH_WIKI), "wiki");
  sh(`git init -q --bare -b master ${wikiOrigin}`);
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-${WITH_WIKI} ${worktree(WITH_WIKI)} origin/integration`,
  );
  sh(`git clone -q ${wikiOrigin} ${wiki} 2>/dev/null`);
  sh(
    `cd ${wiki} && echo home > Home.md && git add . && git ${COMMITTER} commit -qm home && git push -q origin HEAD:master`,
  );
  sh(
    `cd ${wiki} && echo page > Page.md && git add . && git ${COMMITTER} commit -qm page`,
  );
  const sha = sh(`git -C ${wiki} rev-parse HEAD`);
  const config = configWith({ wiki: { url: wikiOrigin } });
  assert.deepEqual(stopAt(WITH_WIKI, "implement", { config }), STOP_REPLY);
  assert.equal(headOf(wikiOrigin, `agent/issue-${WITH_WIKI}`), sha);
});
