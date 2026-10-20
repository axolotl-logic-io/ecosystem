// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { readWorld } from "./pipeline-flow-gh-world.mjs";
import { BASE, bareGit, refIn, WIKI_BRANCH } from "./pipeline-flow-kit.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { piLog } from "./pipeline-flow-pi.mjs";
import { merges, sessions } from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run.mjs";
import { securityTurn } from "./pipeline-flow-script.mjs";
import {
  mergedWikiFlow,
  reviewerTurns,
  stateOf,
} from "./postmerge-wiki-test-kit.mjs";

/** @type {import("./pipeline-flow-kit.mjs").Flow} */
let flow;
let wikiBase = "";
let code = "";
let source = "";
let traceStart = 0;
after(() => stopJobs(flow));

/** @param {string} page */
function wikiTurn(page) {
  return {
    files: { "docs/Home.md": page },
    commits: [
      ["-m", "Refuse code commit", "--", "repo/greet.txt"],
      ["-m", "Document greeting", "--", "docs/Home.md"],
    ],
    output: { outcome: "done", summary: "Wiki-only hardening" },
  };
}

test("initial postmerge Review receives authoritative docs without any issue wiki branch and reads the actual merged result", () => {
  flow = mergedWikiFlow();
  code = String(refIn(flow.origin, BASE));
  source = String(refIn(flow.origin, "agent/issue-7"));
  wikiBase = String(refIn(flow.wikiOrigin, WIKI_BRANCH));
  traceStart = opsTrace(flow).length;
  assert.equal(runStage(flow, "review").end, "deferred");
  const state = stateOf(flow);
  assert.deepEqual(state.flows, { code: true, wiki: false });
  assert.deepEqual(state.codeMerged, { pr: state.pr, sha: code });
  assert.equal(state.merged, null);
  assert.equal(state.mergeAttempt, null);
  assert.equal(state.hardened, null);
  assert.equal(refIn(flow.wikiOrigin, "agent/issue-7"), null);
  assert.equal(
    refIn(path.join(flow.root, "work/o__r/wiki-mirror.git"), "agent/issue-7"),
    null,
  );
  const launch = piLog(flow.piDir)
    .filter(({ start }) => start === true)
    .at(-1);
  assert.equal(launch.docsAvailable, true);
  assert.equal(launch.repoHead, code);
  assert.notEqual(launch.repoHead, source);
  assert.deepEqual(launch.scope.repo, { dir: "repo", access: "read" });
  assert.deepEqual(launch.scope.docs, { dir: "docs", access: "write" });
  assert.deepEqual(launch.scope.allowed, []);
  const { prompt: task } = piLog(flow.piDir)
    .filter(({ prompt }) => typeof prompt === "string")
    .at(-1);
  assert.ok(task.includes("The code already merged"), task);
  assert.ok(task.includes("Wiki pages to update:\n- Home"), task);
});

test("restart with retained merged truth authors first wiki work and a bounded wiki check-fix with the same wiki-only scope", () => {
  const retained = stateOf(flow).codeMerged;
  reviewerTurns(flow, [
    wikiTurn("The wiki has a [link](missing) to a missing page.\n"),
    wikiTurn("The wiki.\n\nGreetings say Hello, world!\n"),
    securityTurn(),
  ]);
  const before = sessions(flow);
  assert.equal(runStage(flow, "review").end, "next");
  const starts = piLog(flow.piDir)
    .filter(({ start }) => start === true)
    .slice(before);
  assert.equal(starts.length, 2);
  for (const launch of starts) {
    assert.equal(launch.docsAvailable, true);
    assert.equal(launch.repoHead, code);
    assert.deepEqual(launch.scope.repo, { dir: "repo", access: "read" });
    assert.deepEqual(launch.scope.docs, { dir: "docs", access: "write" });
    assert.deepEqual(launch.scope.allowed, []);
  }
  const errors = piLog(flow.piDir).filter(
    ({ commitError }) => typeof commitError === "string",
  );
  assert.equal(errors.length, 2);
  for (const { commitError } of errors) {
    assert.ok(commitError.includes("read"), commitError);
  }
  const state = stateOf(flow);
  assert.deepEqual(state.codeMerged, retained);
  assert.equal(state.mergeAttempt, null);
  assert.equal(state.merged, null);
  assert.equal(state.security, null);
  assert.equal(state.hardened.code, code);
  assert.notEqual(state.hardened.wiki, null);
  assert.deepEqual(state.flows, { code: false, wiki: true });
  assert.equal(refIn(flow.wikiOrigin, WIKI_BRANCH), wikiBase);
  assert.equal(refIn(flow.origin, "agent/issue-7"), source);
});

test("actual-result checks and fresh exact security precede wiki publication without code writes or repeat merge", () => {
  fs.writeFileSync(
    path.join(flow.root, "interrupt-publish"),
    "pause publication",
  );
  assert.equal(runStage(flow, "merge").end, "deferred");
  const checked = stateOf(flow);
  assert.deepEqual(checked.security.revision, checked.hardened);
  assert.equal(checked.security.finding, null);
  assert.equal(checked.merged, null);
  assert.equal(refIn(flow.wikiOrigin, WIKI_BRANCH), wikiBase);
  fs.unlinkSync(path.join(flow.root, "interrupt-publish"));
  const before = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "next");
  assert.equal(sessions(flow), before);
  const done = stateOf(flow);
  assert.equal(done.stage, "done");
  assert.deepEqual(done.merged, done.security.revision);
  assert.equal(refIn(flow.wikiOrigin, WIKI_BRANCH), done.merged.wiki);
  assert.equal(
    bareGit(flow.origin, ["show", `${code}:greet.txt`]),
    "Hello, world!",
  );
  assert.equal(refIn(flow.origin, BASE), code);
  // Ordinary completion removes the issue branch; it never pushes new code.
  assert.equal(refIn(flow.origin, "agent/issue-7"), null);
  assert.equal(merges(flow).length, 0);
  const trace = opsTrace(flow).slice(traceStart);
  assert.equal(
    trace.some(({ request }) =>
      ["merge", "exit-push", "sync-base", "ready-pr"].includes(request.op),
    ),
    false,
  );
  const pushes = trace.filter(({ request }) => request.op === "push");
  assert.ok(pushes.length > 0);
  for (const { request } of pushes) {
    assert.ok("wikiOnly" in request && request.wikiOnly === true);
  }
  assert.ok(
    trace.some(({ request, reply }) => {
      const { headSha, pass } = reply;
      return request.op === "verify" && headSha === code && pass === true;
    }),
  );
  assert.ok(
    trace.some(({ request, reply }) => {
      const { pass } = reply;
      return request.op === "wiki-check" && pass === false;
    }),
  );
  assert.deepEqual(readWorld(flow.ghDir).unsupported, []);
});
