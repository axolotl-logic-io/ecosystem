import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  type ExecutionContext,
  type ExecutionHost,
  type ExecutionResult,
  executeTask,
  type TaskDefinition,
} from "../../src/index.ts";

const invocation = {
  version: 1,
  task: "sample",
  execution: "attempt-1",
  inputs: { text: "hello" },
};

function fixture(): {
  task: TaskDefinition<
    { text: string },
    { write: (text: string) => void },
    string
  >;
  host: ExecutionHost<string>;
  controller: AbortController;
  events: string[];
  reports: ExecutionResult<string>[];
} {
  const controller = new AbortController();
  const events: string[] = [];
  const reports: ExecutionResult<string>[] = [];
  return {
    controller,
    events,
    reports,
    task: {
      id: "sample",
      inputs: z.strictObject({ text: z.string() }),
      run: (
        inputs: { text: string },
        capabilities: { write: (text: string) => void },
        context: ExecutionContext,
      ): Promise<{ status: "completed"; result: string }> => {
        context.checkCancelled();
        capabilities.write(inputs.text);
        return Promise.resolve({ status: "completed", result: inputs.text });
      },
    },
    host: {
      signal: controller.signal,
      artifacts: { publish: (): Promise<void> => Promise.resolve() },
      cleanup: (): Promise<void> => {
        events.push("cleanup");
        return Promise.resolve();
      },
      report: (result: ExecutionResult<string>): Promise<void> => {
        events.push("report");
        reports.push(result);
        return Promise.resolve();
      },
    },
  };
}

test("a supplied capability runs without application configuration", async () => {
  const { task, host, events } = fixture();
  const result = await executeTask(
    task,
    invocation,
    () =>
      Promise.resolve({
        write: (text: string): void => {
          events.push(text);
        },
      }),
    host,
  );
  assert.deepEqual(result, {
    status: "finished",
    outcome: { status: "completed", result: "hello" },
  });
  assert.deepEqual(events, ["hello", "cleanup", "report"]);
});

test("domain blocking is distinct from execution failure", async () => {
  const { task, host } = fixture();
  task.run = (): Promise<{ status: "blocked"; result: string }> =>
    Promise.resolve({ status: "blocked", result: "prerequisite" });
  const result = await executeTask(
    task,
    invocation,
    () =>
      Promise.resolve({
        write: (): void => {
          /* This task does not use the write capability. */
        },
      }),
    host,
  );
  assert.deepEqual(result, {
    status: "finished",
    outcome: { status: "blocked", result: "prerequisite" },
  });
  task.run = (): Promise<never> => Promise.reject(new Error("broken"));
  assert.equal(
    (
      await executeTask(
        task,
        invocation,
        () =>
          Promise.resolve({
            write: (): void => {
              /* This task does not use the write capability. */
            },
          }),
        host,
      )
    ).status,
    "failed",
  );
});

test("abort prevents provisioning but still cleans up and reports", async () => {
  const { task, host, controller, events, reports } = fixture();
  controller.abort("operator stop");
  const result = await executeTask(
    task,
    invocation,
    (): Promise<never> => {
      assert.fail("must not provision");
    },
    host,
  );
  assert.deepEqual(result, { status: "cancelled", reason: "operator stop" });
  assert.deepEqual(events, ["cleanup", "report"]);
  assert.deepEqual(reports, [result]);
});

test("invalid input fails before provisioning and finalizes", async () => {
  const { task, host, events } = fixture();
  const result = await executeTask(
    task,
    { ...invocation, inputs: { text: 2 } },
    (): Promise<never> => {
      assert.fail("must not provision");
    },
    host,
  );
  assert.equal(result.status, "failed");
  assert.deepEqual(events, ["cleanup", "report"]);
});

test("cleanup failure is reported as execution failure", async () => {
  const { task, host, reports } = fixture();
  host.cleanup = (): Promise<never> =>
    Promise.reject(new Error("cleanup failed"));
  const result = await executeTask(
    task,
    invocation,
    () =>
      Promise.resolve({
        write: (): void => {
          /* This task does not use the write capability. */
        },
      }),
    host,
  );
  assert.equal(result.status, "failed");
  assert.deepEqual(reports, [result]);
});

test("cancellation during provisioning prevents task effects and finalizes", async () => {
  const { task, host, controller, events } = fixture();
  const result = await executeTask(
    task,
    invocation,
    () => {
      controller.abort("shutdown");
      return Promise.resolve({
        write: (): void => {
          assert.fail("cancelled task wrote");
        },
      });
    },
    host,
  );
  assert.deepEqual(result, { status: "cancelled", reason: "shutdown" });
  assert.deepEqual(events, ["cleanup", "report"]);
});
