// @ts-check
// The implementor's start sync (#419) continues a resolved rebase itself
// (its `continue` check). When that replays commits that move the wiki pin
// and put it back, with the wiki checkout ahead of the pin (#458), the next
// resolver still sees only the next commit's conflict, never the moved wiki
// checkout. A real job checkout against local origins; no model, no ops.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BASE } from "./job-git-test-kit.mjs";
import {
  configIn,
  git,
  ISSUE,
  root,
  write,
} from "./pipeline-commit-test-kit.mjs";
import { movePinAndBack, statusOf, wikiAhead } from "./wiki-pin-test-kit.mjs";

const { openJobCheckout } = await import("../src/job/checkout.ts");
const { syncChecks } = await import("../src/roles/implementor/sync-checks.ts");

/** @import { JobEffects } from "../src/roles/registry.ts" */

const COMMIT_ENV = Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]);

/** @returns {Promise<never>} */
function unused() {
  return Promise.reject(new Error("the continue check runs no op or session"));
}

/** @type {JobEffects} */
const EFFECTS = {
  op: unused,
  session: unused,
  sessions: unused,
  usage: unused,
  save: unused,
  clock: () => new Date(0),
  stopping: () => null,
  step: () => undefined,
  moved: () => undefined,
};

/** @param {string} dir @param {string} file @param {string} text commits `file` holding `text` in `dir` */
function commitFile(dir, file, text) {
  write(dir, file, `${text}\n`);
  git(dir, ["add", file]);
  git(dir, ["commit", "--quiet", "-m", `${file}: ${text}`], COMMIT_ENV);
}

/**
 * Moves the base on `origin` with "theirs" in each of `files`.
 * @param {string} origin
 * @param {readonly string[]} files
 */
function moveBase(origin, files) {
  const seed = `${origin}-seed`;
  for (const file of files) {
    fs.writeFileSync(path.join(seed, file), "theirs\n");
  }
  git(seed, ["add", ...files]);
  const identity = [
    "-c",
    "user.name=Seed",
    "-c",
    "user.email=seed@example.com",
  ];
  git(seed, [...identity, "commit", "--quiet", "-m", "theirs"]);
  git(seed, ["push", "--quiet", origin, `HEAD:refs/heads/${BASE}`]);
}

test("the role's continue past commits that move the wiki pin stops on the next conflict with the wiki checkout left out", async () => {
  const tmp = fs.mkdtempSync(path.join(root, "sync-wiki-pin-"));
  const cfg = configIn(tmp);
  const job = { stage: "sync", stackOn: null };
  const { repo } = openJobCheckout(cfg, ISSUE, job);
  wikiAhead(repo, "Ahead");
  commitFile(repo, "first.txt", "mine");
  movePinAndBack(repo);
  commitFile(repo, "second.txt", "mine");
  moveBase(path.join(tmp, "origin.git"), ["first.txt", "second.txt"]);
  git(repo, ["fetch", "--quiet", "origin"]);
  const rebase = ["rebase", "--quiet", `origin/${BASE}`];
  assert.throws(() => git(repo, rebase, COMMIT_ENV));
  write(repo, "first.txt", "resolved\n");
  git(repo, ["add", "first.txt"]);
  const checks = syncChecks(EFFECTS, cfg, { issue: ISSUE, dir: repo });
  const { continue: go } = checks;
  assert.ok(go !== undefined);
  const outcome = await go({});
  assert.deepEqual(outcome, {
    ok: true,
    name: "conflict",
    reply: { files: ["second.txt"] },
  });
  assert.equal(statusOf(repo), "AA second.txt");
});
