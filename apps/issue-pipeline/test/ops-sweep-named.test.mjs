// @ts-check
// The sweep op for one named issue with or without a stop label: a named run
// leaves a stopped issue alone unless it says takeStopped (#251).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askOps,
  CONFIG,
  publicConfigOf,
  reply,
  writes,
} from "./ops-cli-test-kit.mjs";
import {
  candidate,
  LANE,
  row,
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
  assert.deepEqual(writes(), []);
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
  assert.deepEqual(writes(), []);
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
  assert.deepEqual(writes(), []);
});
