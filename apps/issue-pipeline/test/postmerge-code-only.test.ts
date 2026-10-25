import assert from "node:assert/strict";
import { after, test } from "node:test";
import { opsTrace } from "./pipeline-flow-ops-test-kit.ts";
import { opsSince } from "./pipeline-flow-post-land-test-kit.ts";
import { merges, sessions } from "./pipeline-flow-replay-test-kit.ts";
import { runStage, stopJobs } from "./pipeline-flow-run-test-kit.ts";
import {
  hardeningTurn,
  securityTurn,
} from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { BASE, refIn } from "./pipeline-flow-test-kit.ts";
import {
  externallyMergedFlow,
  reviewerTurns,
  stateOf,
} from "./postmerge-test-kit.ts";

let flow: Flow;
after(() => stopJobs(flow));

// Checks and Security clear only the exact candidate before the target
// moves (#185): code merged outside the pipeline has no such proof, so it
// stops with its merged truth kept rather than getting postmerge hardening.
test("an external code merge stops read-only: no suite, model, writer, Security or completion", () => {
  flow = externallyMergedFlow();
  const code = refIn(flow.origin, BASE);
  reviewerTurns(flow, [hardeningTurn(), securityTurn()]);
  const before = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "review").end, "stop");
  assert.equal(sessions(flow), starts);
  const stopped = stateOf(flow);
  assert.equal(stopped.stage, "stopped");
  assert.equal(stopped.stopCode, "error");
  assert.equal(stopped.codeMerged?.sha, code);
  assert.equal(stopped.security, null);
  assert.equal(refIn(flow.origin, BASE), code);
  assert.equal(merges(flow).length, 0);
  const ops = opsSince(flow, before);
  for (const op of [
    "verify",
    "prepare-review",
    "merge",
    "exit-push",
    "sync-base",
    "finish",
  ]) {
    assert.equal(ops.includes(op), false, op);
  }
});
