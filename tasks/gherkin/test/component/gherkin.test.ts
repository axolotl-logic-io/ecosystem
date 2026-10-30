import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExecutionResult, executeTask } from "@ecosystem/task-framework";
import {
  type GherkinReply,
  type GherkinSession,
  gherkin,
} from "../../src/index.ts";

const INPUTS = {
  issue: {
    repository: "example/widgets",
    number: 7,
    context: "# Count widgets\n\nOnly intact widgets count.",
  },
  baseBranch: "main",
  model: "provider/resolved-model",
};
const FEATURE = "Feature: Count widgets\n  Scenario: Count intact widgets";

function host(
  reply: unknown,
  controller: AbortController = new AbortController(),
): {
  execute: (inputs?: unknown) => Promise<ExecutionResult<GherkinReply>>;
  artifacts: Map<string, string>;
  sessions: GherkinSession[];
  reports: ExecutionResult<GherkinReply>[];
  cleaned: () => boolean;
} {
  const artifacts = new Map<string, string>();
  const sessions: GherkinSession[] = [];
  const reports: ExecutionResult<GherkinReply>[] = [];
  let cleaned = false;
  return {
    artifacts,
    sessions,
    reports,
    cleaned: (): boolean => cleaned,
    execute: (
      inputs: unknown = INPUTS,
    ): Promise<ExecutionResult<GherkinReply>> =>
      executeTask(
        gherkin,
        { version: 1, task: "gherkin", execution: "attempt-1", inputs },
        () =>
          Promise.resolve({
            openRepository: () =>
              Promise.resolve({
                directory: "/read-only/repo",
                revision: "abc",
              }),
            runModel: (session: GherkinSession): Promise<unknown> => {
              sessions.push(session);
              return Promise.resolve(reply);
            },
          }),
        {
          signal: controller.signal,
          artifacts: {
            publish: (name: string, content: string): Promise<void> => {
              artifacts.set(name, content);
              return Promise.resolve();
            },
          },
          cleanup: (): Promise<void> => {
            cleaned = true;
            return Promise.resolve();
          },
          report: (result: ExecutionResult<GherkinReply>): Promise<void> => {
            reports.push(result);
            return Promise.resolve();
          },
        },
      ),
  };
}

test("a supplied host completes Gherkin and publishes formatted behaviour", async () => {
  const box = host({
    outcome: "gherkin",
    gherkin: `  ${FEATURE}\n`,
    assumptions: ["Broken widgets do not count."],
  });
  const result = await box.execute();
  assert.ok(result.status === "finished");
  assert.equal(result.outcome.status, "completed");
  assert.equal(box.artifacts.size, 1);
  assert.ok(box.artifacts.get("gherkin")?.includes(`\n${FEATURE}\n`));
  assert.ok(
    box.artifacts.get("gherkin")?.includes("- Broken widgets do not count."),
  );
  const [session] = box.sessions;
  assert.deepEqual(session?.inputs, INPUTS);
  assert.deepEqual(session?.repository, {
    directory: "/read-only/repo",
    revision: "abc",
  });
  assert.equal(box.cleaned(), true);
  assert.deepEqual(box.reports, [result]);
});

test("questions are a needs-input domain outcome and publish no behaviour", async () => {
  const box = host({
    outcome: "needs-info",
    questions: ["Do broken widgets count?"],
  });
  const result = await box.execute();
  assert.ok(result.status === "finished");
  assert.equal(result.outcome.status, "needs-input");
  assert.equal(box.artifacts.size, 1);
  assert.ok(
    box.artifacts.get("questions")?.includes("- Do broken widgets count?"),
  );
  assert.equal(box.artifacts.has("gherkin"), false);
});

test("an invalid model reply fails without publishing an artifact", async () => {
  const box = host({ outcome: "needs-info", questions: [] });
  assert.equal((await box.execute()).status, "failed");
  assert.equal(box.artifacts.size, 0);
  assert.equal(box.cleaned(), true);
});

test("unresolved inputs fail before a model session", async () => {
  const box = host({ outcome: "gherkin", gherkin: FEATURE, assumptions: [] });
  assert.equal((await box.execute({ issue: INPUTS.issue })).status, "failed");
  assert.equal(box.sessions.length, 0);
  assert.equal(box.artifacts.size, 0);
});

test("cancellation before execution publishes nothing and still finalizes", async () => {
  const controller = new AbortController();
  controller.abort("stop");
  const box = host(
    { outcome: "gherkin", gherkin: FEATURE, assumptions: [] },
    controller,
  );
  assert.equal((await box.execute()).status, "cancelled");
  assert.equal(box.sessions.length, 0);
  assert.equal(box.artifacts.size, 0);
  assert.equal(box.cleaned(), true);
  assert.equal(box.reports.length, 1);
});
