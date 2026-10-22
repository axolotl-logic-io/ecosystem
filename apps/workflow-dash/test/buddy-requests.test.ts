import assert from "node:assert/strict";
import { test } from "node:test";
import { supervisorPending } from "../buddy-runs.ts";
import { buddyStatusSchema, type ContactEvent } from "../source-records.ts";

test("supervisor requests come from unmatched contacts; progress is not pending", () => {
  const start: ContactEvent = {
    type: "tool_execution_start",
    toolName: "contact_supervisor",
    toolCallId: "request",
    args: { reason: "need_decision", message: "Choose next task" },
  };
  assert.equal(
    supervisorPending({ state: "running" }, [start]),
    "Choose next task",
  );
  assert.equal(
    supervisorPending({ state: "running" }, [
      start,
      {
        type: "tool_execution_end",
        toolName: "contact_supervisor",
        toolCallId: "request",
      },
    ]),
    "none",
  );
  assert.equal(supervisorPending({ state: "complete" }, []), "none");
  assert.equal(
    supervisorPending({ state: "running" }, [
      { ...start, args: { reason: "progress_update" } },
    ]),
    "none",
  );
  assert.equal(supervisorPending({ state: "complete" }, [start]), "none");
  assert.ok(
    supervisorPending(
      {
        state: "running",
        steps: [
          {
            currentTool: "contact_supervisor",
            currentToolArgs: "reason=need_decision",
          },
        ],
      },
      [],
    ).includes("need_decision"),
  );
  const attention = buddyStatusSchema.parse({
    state: "running",
    activityState: "needs_attention",
    steps: [{ currentTool: "bash" }],
  });
  assert.equal(supervisorPending(attention, []), "none");
});
