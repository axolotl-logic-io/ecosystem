// @ts-check
// The sweep op for one named issue with or without a stop label: a named run
// leaves a stopped issue alone unless it says takeStopped (#251).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED,
  askOps,
  CONFIG,
  calls,
  ghCalls,
  publicConfigOf,
  reply,
} from "./ops-cli-test-kit.mjs";
import {
  candidate,
  LANE,
  listComments,
  row,
  SWEEP_HEAD,
  sweepReplies,
  sweepReply,
} from "./ops-sweep-test-kit.mjs";

const STOPPED = 30;

test("a sweep for one named issue leaves a stopped issue alone", () => {
  const n = STOPPED;
  const label = "agent:stopped-triage-rejected";
  reply(
    sweepReplies([row(n, ["agent:working", label, "agent:stopped-error"])]),
  );
  assert.deepEqual(
    askOps({ op: "sweep", only: n, ...LANE }),
    sweepReply({
      config: publicConfigOf(CONFIG),
      items: [],
      stopped: { issue: n, label },
    }),
  );
  assert.deepEqual(calls(), [...SWEEP_HEAD, ghCalls.collaborator(ALLOWED)]);
});

test("takeStopped takes a stopped named issue", () => {
  const n = STOPPED;
  const body = "<!-- agent-pipeline:parent 5 depth 1 -->";
  reply(sweepReplies([row(n, ["agent:stopped-error"], { body })]));
  assert.deepEqual(
    askOps({ op: "sweep", only: n, takeStopped: true, ...LANE }),
    sweepReply({
      config: publicConfigOf(CONFIG),
      items: [candidate(n, "named", 1)],
    }),
  );
  assert.deepEqual(calls(), [
    ...SWEEP_HEAD,
    ghCalls.collaborator(ALLOWED),
    listComments(n),
  ]);
});

test("a named issue without a stop label is taken", () => {
  const n = STOPPED;
  reply(sweepReplies([row(n, [])]));
  assert.deepEqual(
    askOps({ op: "sweep", only: n, ...LANE }),
    sweepReply({
      config: publicConfigOf(CONFIG),
      items: [candidate(n, "named")],
    }),
  );
  assert.deepEqual(calls(), [
    ...SWEEP_HEAD,
    ghCalls.collaborator(ALLOWED),
    listComments(n),
  ]);
});
