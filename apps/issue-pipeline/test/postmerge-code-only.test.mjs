// @ts-check
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BASE, refIn } from "./pipeline-flow-kit.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { merges } from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run.mjs";
import { hardeningTurn, securityTurn } from "./pipeline-flow-script.mjs";
import {
  externallyMergedFlow,
  reviewerTurns,
  stateOf,
} from "./postmerge-test-kit.mjs";

/** @type {import("./pipeline-flow-kit.mjs").Flow} */
let flow;
after(() => stopJobs(flow));

test("genuine code-only completion requires no invented edit, commit or push", () => {
  flow = externallyMergedFlow([]);
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
