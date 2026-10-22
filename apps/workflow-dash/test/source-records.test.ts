import assert from "node:assert/strict";
import { test } from "node:test";
import { runningGate, sessionRecords } from "../session-source.ts";
import {
  buddyStatusSchema,
  eventSchema,
  jsonl,
  workflowSchema,
} from "../source-records.ts";

test("legacy nullable observations retain source identities and recorded nulls", () => {
  const record = workflowSchema.parse({
    id: "source-run",
    stage: "merge",
    outcome: null,
    startedAt: null,
    launches: [
      {
        key: "implementor-1",
        lastEventAt: null,
        scope: null,
        usage: { input: 12 },
      },
    ],
  });
  assert.equal(record.id, "source-run");
  assert.equal(record.stage, "merge");
  assert.equal(record.outcome, null);
  assert.equal(record.startedAt, null);
  assert.equal(record.launches[0].key, "implementor-1");
  assert.equal(record.launches[0].scope, null);
  assert.equal(record.launches[0].lastEventAt, null);
  assert.deepEqual(record.launches[0].usage, { input: 12 });
});
test("invalid workflow and buddy shapes fail their source boundary", () => {
  assert.equal(
    workflowSchema.safeParse({ launches: [{ key: 123 }] }).success,
    false,
  );
  assert.equal(
    workflowSchema.safeParse({ launches: "not an array" }).success,
    false,
  );
  assert.equal(buddyStatusSchema.safeParse({ state: 123 }).success, false);
  assert.equal(buddyStatusSchema.safeParse(null).success, false);
});
test("JSONL and session readers ignore primitive, partial and non-message records", () => {
  assert.deepEqual(
    jsonl(
      [
        ...[null, [], 1, "text"].map((value) => JSON.stringify(value)),
        '{"partial":',
      ].join("\n"),
    ),
    [],
  );
  const records = sessionRecords(
    [
      '{"type":"session"}',
      '{"type":"message","message":{"role":7}}',
      '{"type":"message","timestamp":null,"message":{"role":"user"}}',
    ].join("\n"),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].timestamp, null);
  assert.equal(records[0].message.role, "user");
});
test("unidentified gate calls and unrelated contacts cannot establish observations", () => {
  const records = sessionRecords(
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "bash",
            id: null,
            arguments: { command: "npm test" },
          },
        ],
      },
    }),
  );
  assert.equal(runningGate(records), false);
  assert.equal(
    eventSchema.safeParse({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "request",
    }).success,
    false,
  );
  assert.equal(
    eventSchema.safeParse({
      type: "tool_execution_start",
      toolName: "contact_supervisor",
      toolCallId: null,
    }).success,
    false,
  );
});
