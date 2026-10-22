import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { registerReadTools } from "../tools.ts";
import { makeState } from "./model-fixtures.ts";
import {
  detailSchema,
  fixtureIssue,
  fixturePid,
  harness,
  summarySchema,
  toolNames,
} from "./tool-test-kit.ts";

const refreshedTwice = 2;
const bounds = { oversized: 15_000, maximum: 12_000 };
const deprecatedList = /Deprecated: use workflow_runs/u;
const deprecatedDetail = /Deprecated: use workflow_run/u;
const missingRun = /Workflow run not found/u;
const notActive = /not active/u;
const truncated = /Truncated at 12KB/u;
test("canonical tools expose identities and labels without rewriting source keys", async () => {
  const h = harness();
  const summaries = summarySchema.parse(await h.read("workflow_runs"));
  assert.equal(summaries.capacity.observedProcesses, 1);
  assert.equal(summaries.capacity.unknownProcesses, 0);
  assert.equal(summaries.capacity.configuredLimit, null);
  assert.equal(summaries.runs[0].taskCoverage.currentTask, null);
  assert.deepEqual(summaries.runs[0].taskCoverage.tasks, ["Implementation"]);
  assert.equal(summaries.runs[0].id, "source-run-id");
  assert.equal(summaries.runs[0].sourceStage, "implement");
  assert.equal(summaries.runs[0].stageLabel, "Implementation");
  assert.equal(summaries.runs[0].launch, "implementor-1");
  assert.equal(Object.hasOwn(summaries, "jobs"), false);
  const detail = detailSchema.parse(
    await h.read("workflow_run", { repo: "org/repo", issue: fixtureIssue }),
  );
  assert.equal(detail.id, "source-run-id");
  assert.equal(detail.sourceStage, "implement");
  assert.equal(detail.launches[0].key, "implementor-1");
  assert.equal(detail.launches[0].label, "developer-1");
  assert.equal(detail.launches[0].seconds, 1);
  assert.equal(h.run.data.launches[0].key, "implementor-1");
  assert.equal(h.refreshes(), refreshedTwice);
});
test("deprecated tool names preserve their prior JSON contract", async () => {
  const h = harness();
  const list = h.tools.get("pipeline_lanes");
  const detail = h.tools.get("pipeline_job");
  assert.ok(list);
  assert.ok(detail);
  assert.match(list.description, deprecatedList);
  assert.match(detail.description, deprecatedDetail);
  assert.deepEqual(await h.read("pipeline_lanes"), {
    capacity: {
      jobs: 1,
      limit: 4,
      author: 1,
      review: 0,
      authorLimit: 2,
      reviewLimit: 2,
      pbWeb: [],
    },
    jobs: [
      {
        repo: "org/repo",
        issue: fixtureIssue,
        stage: "implement",
        pid: fixturePid,
        launch: "implementor-1",
        startedAt: 1000,
      },
    ],
    hold: false,
    installed: "unknown",
    main: "unknown",
  });
  assert.deepEqual(
    await h.read("pipeline_job", { repo: "org/repo", issue: fixtureIssue }),
    {
      repo: "org/repo",
      issue: fixtureIssue,
      stage: "implement",
      outcome: null,
      stopReason: "not recorded",
      verify: [],
      launches: [
        { key: "implementor-1", kind: "session", startedAt: 1000, seconds: 1 },
      ],
    },
  );
});
test("uncertain runs do not imply activity, completion or a current task", async () => {
  const h = harness();
  h.run.live = null;
  h.run.data.stage = "merge";
  const summary = summarySchema.parse(await h.read("workflow_runs"));
  assert.equal(summary.runs.length, 1);
  assert.equal(summary.capacity.observedProcesses, 0);
  assert.equal(summary.capacity.unknownProcesses, 1);
  assert.equal(summary.runs[0].processObservation, "unknown");
  assert.equal(summary.runs[0].taskCoverage.currentTask, null);
  assert.deepEqual(summary.runs[0].taskCoverage.tasks, [
    "Sync",
    "Integration",
    "Security",
    "Land",
    "Completion",
  ]);
  const detail = detailSchema.parse(
    await h.read("workflow_run", { repo: "org/repo", issue: fixtureIssue }),
  );
  assert.equal(detail.processObservation, "unknown");
  assert.equal(detail.outcome, null);
});
test("native SDK registration receives every read-only tool", () => {
  const names: string[] = [];
  const registry: Pick<ExtensionAPI, "registerTool"> = {
    registerTool<Schema extends TSchema, Detail, ViewState>(
      tool: ToolDefinition<Schema, Detail, ViewState>,
    ): void {
      names.push(tool.name);
      assert.equal(tool.annotations?.readOnlyHint, true);
    },
  };
  registerReadTools(registry, {
    active: () => false,
    refresh: () => Promise.resolve(),
    get: () => makeState(),
  });
  assert.deepEqual(names, toolNames);
});
test("missing workflow runs report a bounded-reader failure", async () => {
  await assert.rejects(
    harness().invoke("workflow_run", {
      repo: "org/missing",
      issue: fixtureIssue,
    }),
    missingRun,
  );
});
for (const name of ["workflow_run", "pipeline_job"]) {
  test(`${name}: output is capped at 12 KB`, async () => {
    const h = harness();
    h.run.data.outcome = "x".repeat(bounds.oversized);
    const output = await h.invoke(name, {
      repo: "org/repo",
      issue: fixtureIssue,
    });
    assert.ok(output.content[0].text.length <= bounds.maximum);
    assert.match(output.content[0].text, truncated);
  });
}
for (const name of toolNames) {
  test(`${name}: inactive tools refuse reads before refresh`, async () => {
    const h = harness();
    h.deactivate();
    const before = h.refreshes();
    await assert.rejects(
      h.invoke(name, { repo: "org/repo", issue: fixtureIssue }),
      notActive,
    );
    assert.equal(h.refreshes(), before);
  });
}
