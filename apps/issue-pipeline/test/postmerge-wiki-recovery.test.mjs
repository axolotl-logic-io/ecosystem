// @ts-check
// Restoring docs/ must keep private wiki history and inert recovery evidence.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { git } from "./job-git-test-kit.mjs";
import { BASE, refIn, WIKI_BRANCH } from "./pipeline-flow-kit.mjs";
import { piLog } from "./pipeline-flow-pi.mjs";
import { merges, sessions } from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run.mjs";
import { mergedWikiFlow, stateOf } from "./postmerge-wiki-test-kit.mjs";

/** @type {import("./pipeline-flow-kit.mjs").Flow} */
let flow;
let mirror = "";
let privateHead = "";
let source = "";
let evidence = "";
const BRANCH = "agent/issue-7";
const EVIDENCE =
  "Retained operator recovery evidence; never replay automatically.\n";
const DIVERGED = /private wiki recovery and remote issue branch diverged/u;
const REQUIRED = /required wiki updates \(Home\)/u;
const RETAINED_CHECKOUT = /already exists/u;
after(() => stopJobs(flow));

test("postmerge hardening restores private wiki commits before launch instead of replacing them with the configured base", () => {
  flow = mergedWikiFlow();
  mirror = path.join(flow.root, "work/o__r/wiki-mirror.git");
  source = String(refIn(flow.origin, BASE));
  const seed = path.join(flow.tmp, "wiki-seed");
  fs.writeFileSync(path.join(seed, "Retained.md"), "Private wiki work.\n");
  git(["-C", seed, "add", "Retained.md"]);
  git(["-C", seed, "commit", "-qm", "Retain unpublished wiki work"]);
  privateHead = git(["-C", seed, "rev-parse", "HEAD"]);
  git([
    "--git-dir",
    mirror,
    "fetch",
    "--quiet",
    seed,
    `HEAD:refs/heads/${BRANCH}`,
  ]);
  evidence = path.join(flow.root, "runs/o__r/issue-7/dropped/retained.patch");
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence, EVIDENCE);
  assert.equal(refIn(flow.wikiOrigin, BRANCH), null);
  assert.equal(runStage(flow, "review").end, "deferred");
  const launch = piLog(flow.piDir)
    .filter(({ start }) => start === true)
    .at(-1);
  assert.equal(launch.docsAvailable, true);
  assert.equal(launch.docsHead, privateHead);
  assert.notEqual(launch.docsHead, refIn(flow.wikiOrigin, WIKI_BRANCH));
  assert.equal(launch.repoHead, source);
  assert.deepEqual(launch.scope.repo, { dir: "repo", access: "read" });
  assert.deepEqual(launch.scope.docs, { dir: "docs", access: "write" });
  assert.equal(refIn(mirror, BRANCH), privateHead);
  assert.equal(fs.readFileSync(evidence, "utf8"), EVIDENCE);
  const state = stateOf(flow);
  assert.deepEqual(state.codeMerged, { pr: state.pr, sha: source });
  assert.equal(state.hardened, null);
  assert.equal(state.merged, null);
  assert.equal(state.mergeAttempt, null);
  assert.equal(merges(flow).length, 0);
});

test("divergent retained and remote wiki work holds before launch with both refs and the failed checkout preserved", () => {
  const retained = stateOf(flow);
  const remoteSeed = path.join(flow.tmp, "wiki-remote-work");
  git(["clone", "--quiet", flow.wikiOrigin, remoteSeed]);
  fs.writeFileSync(
    path.join(remoteSeed, "Remote.md"),
    "Independent remote wiki work.\n",
  );
  git(["-C", remoteSeed, "add", "Remote.md"]);
  git(["-C", remoteSeed, "commit", "-qm", "Independent wiki work"]);
  const remoteHead = git(["-C", remoteSeed, "rev-parse", "HEAD"]);
  git([
    "-C",
    remoteSeed,
    "push",
    "--quiet",
    "--force",
    "origin",
    `HEAD:refs/heads/${BRANCH}`,
  ]);
  const before = sessions(flow);
  assert.throws(
    () => runStage(flow, "review"),
    (error) => {
      assert.match(String(error), DIVERGED);
      assert.match(String(error), REQUIRED);
      return true;
    },
  );
  assert.equal(sessions(flow), before);
  assert.deepEqual(stateOf(flow), retained);
  assert.equal(refIn(mirror, BRANCH), privateHead);
  assert.equal(refIn(mirror, `refs/remotes/origin/${BRANCH}`), remoteHead);
  assert.equal(refIn(flow.wikiOrigin, BRANCH), remoteHead);
  assert.equal(fs.readFileSync(evidence, "utf8"), EVIDENCE);
  const checkout = path.join(flow.root, "work/o__r/jobs/issue-7-review");
  assert.equal(fs.existsSync(path.join(checkout, "repo/.git")), true);
  assert.equal(fs.existsSync(path.join(checkout, "docs/.git")), true);
  assert.equal(refIn(flow.origin, BASE), source);
  assert.equal(merges(flow).length, 0);
  // Retrying cannot silently discard the failed checkout or either history.
  assert.throws(() => runStage(flow, "review"), RETAINED_CHECKOUT);
  assert.equal(sessions(flow), before);
  assert.equal(refIn(mirror, BRANCH), privateHead);
  assert.equal(refIn(mirror, `refs/remotes/origin/${BRANCH}`), remoteHead);
});
