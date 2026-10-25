import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { snapshot } from "../data.ts";
import { type ReadTool, readTools } from "../tools.ts";
import {
  actionRun,
  actionRunPath,
  buddyRun,
  buddyRunPath,
  repo,
  writeObservation,
  writeText,
} from "./runtime-run-fixtures.ts";
import { runtimeFixture } from "./runtime-test-kit.ts";

const options = { timeout: 30_000 };
const issue = 3;
const notObserved = /Action run not observed/u;
const notAuthority = /never authority/u;
const notCurrent = /not the current workflow/u;
const textSchema = z.object({
  content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
});
const runtimeSummarySchema = z.object({
  note: z.string(),
  coverage: z.object({
    repositories: z.array(z.string()),
    configWarnings: z.array(z.string()),
  }),
  problems: z.array(z.object({ path: z.string(), reason: z.string() })),
  buddyRuns: z.array(
    z.object({
      id: z.string(),
      condition: z.object({ state: z.string() }),
      actionRuns: z.array(z.string()),
    }),
  ),
  actionRuns: z.array(
    z.object({
      id: z.string(),
      buddyRun: z.object({ id: z.string(), condition: z.string() }),
      sessions: z.array(z.string()),
    }),
  ),
});
const actionDetailSchema = z.object({
  links: z.object({
    buddyRun: z.object({ id: z.string(), condition: z.string() }),
    previous: z.object({ id: z.string().nullable(), observed: z.boolean() }),
    sessions: z.array(
      z.object({
        id: z.string(),
        key: z.string(),
        file: z.string().nullable(),
        fileState: z.string(),
        parentMatches: z.boolean(),
      }),
    ),
  }),
  observation: z.object({ id: z.string(), buddyRun: z.string() }),
});

function tool(tools: ReadTool[], name: string): ReadTool {
  const found = tools.find((item) => item.name === name);
  if (found === undefined) {
    throw new Error(`tool ${name} not registered`);
  }
  return found;
}
async function invoke(
  tools: ReadTool[],
  name: string,
  input: unknown,
): Promise<unknown> {
  const result = textSchema.parse(
    await tool(tools, name).execute("call", input),
  );
  const parsed: unknown = JSON.parse(result.content[0].text);
  return parsed;
}

test(
  "buddy_runs and action_run report recorded observations and their explicit links",
  options,
  async (context) => {
    const { runtime, host, configPath } = await runtimeFixture(
      context,
      snapshot,
    );
    const runs = join(dirname(configPath), "runs");
    const buddyId = randomUUID();
    const actionId = randomUUID();
    const sessionId = randomUUID();
    const unreadable = buddyRunPath(runs, randomUUID());
    await writeObservation(buddyRunPath(runs, buddyId), buddyRun(buddyId));
    await writeText(unreadable, "not json");
    await writeObservation(
      actionRunPath(runs, issue, actionId),
      actionRun(actionId, buddyId, issue, {
        state: "ended",
        outcome: "succeeded",
        sessions: [
          {
            id: sessionId,
            parent: actionId,
            key: "implement-1",
            agent: "fixture-agent",
            model: "fixture-model",
            phase: null,
            commits: true,
            pid: null,
            reservation: null,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            outcome: "ok",
          },
        ],
      }),
    );
    const session = join(
      dirname(actionRunPath(runs, issue, actionId)),
      "sessions",
      "implement-1.jsonl",
    );
    await writeText(session, "");
    await runtime.start(host.context, configPath);
    const tools = readTools({
      active: () => runtime.active,
      refresh: () => runtime.refresh(),
      get: () => runtime.state,
    });
    assert.deepEqual(
      tools.map((item) => [item.name, item.annotations.readOnlyHint]),
      [
        ["buddy_runs", true],
        ["action_run", true],
        ["workflow_runs", true],
        ["workflow_run", true],
        ["pipeline_lanes", true],
        ["pipeline_job", true],
      ],
    );

    const summary = runtimeSummarySchema.parse(
      await invoke(tools, "buddy_runs", {}),
    );
    assert.match(summary.note, notAuthority);
    assert.deepEqual(summary.coverage.repositories, [repo]);
    assert.deepEqual(
      summary.problems.map((item) => [item.path, item.reason]),
      [[unreadable, "invalid JSON"]],
    );
    assert.deepEqual(
      summary.buddyRuns.map((item) => [item.id, item.actionRuns]),
      [[buddyId, [actionId]]],
    );
    assert.deepEqual(
      summary.actionRuns.map((item) => [
        item.id,
        item.buddyRun.id,
        item.sessions,
      ]),
      [[actionId, buddyId, [sessionId]]],
    );

    const detail = actionDetailSchema.parse(
      await invoke(tools, "action_run", { id: actionId }),
    );
    assert.equal(detail.observation.id, actionId);
    assert.equal(detail.links.buddyRun.id, buddyId);
    assert.deepEqual(detail.links.previous, { id: null, observed: false });
    assert.deepEqual(detail.links.sessions, [
      {
        id: sessionId,
        key: "implement-1",
        file: session,
        fileState: "present",
        parentMatches: true,
      },
    ]);
    await assert.rejects(
      tool(tools, "action_run").execute("call", { id: randomUUID() }),
      notObserved,
    );

    const history = z
      .object({ history: z.string() })
      .parse(await invoke(tools, "workflow_runs", {}));
    assert.match(history.history, notCurrent);
  },
);
