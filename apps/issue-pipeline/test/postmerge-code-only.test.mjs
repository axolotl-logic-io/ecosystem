// @ts-check
import assert from "node:assert/strict";
import path from "node:path";
import { after, test } from "node:test";
import { BASE, refIn, WIKI_BRANCH } from "./pipeline-flow-kit.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { merges } from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run.mjs";
import { hardeningTurn, securityTurn } from "./pipeline-flow-script.mjs";
import {
  mergedWikiFlow,
  reviewerTurns,
  stateOf,
} from "./postmerge-wiki-test-kit.mjs";

/** @type {import("./pipeline-flow-kit.mjs").Flow} */
let flow;
after(() => stopJobs(flow));

test("genuine code-only completion requires no invented wiki edit, commit or publication", () => {
  flow = mergedWikiFlow([]);
  const wiki = refIn(flow.wikiOrigin, WIKI_BRANCH);
  const code = refIn(flow.origin, BASE);
  reviewerTurns(flow, [hardeningTurn(), securityTurn()]);
  const before = opsTrace(flow).length;
  assert.equal(runStage(flow, "review").end, "next");
  const hardened = stateOf(flow);
  assert.equal(hardened.hardened.wiki, null);
  assert.equal(runStage(flow, "merge").end, "next");
  const done = stateOf(flow);
  assert.equal(done.stage, "done");
  assert.equal(done.merged.wiki, null);
  assert.deepEqual(done.security.revision, done.merged);
  assert.equal(done.security.finding, null);
  assert.equal(refIn(flow.origin, BASE), code);
  assert.equal(refIn(flow.wikiOrigin, WIKI_BRANCH), wiki);
  assert.equal(refIn(flow.wikiOrigin, "agent/issue-7"), null);
  assert.equal(
    refIn(path.join(flow.root, "work/o__r/wiki-mirror.git"), "agent/issue-7"),
    null,
  );
  assert.equal(merges(flow).length, 0);
  assert.equal(
    opsTrace(flow)
      .slice(before)
      .some(({ request }) =>
        ["merge", "exit-push", "sync-base"].includes(request.op),
      ),
    false,
  );
});
