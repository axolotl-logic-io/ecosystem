import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { capacity } from "../legacy-capacity.ts";
import {
  observeWebGate,
  runningGate,
  webProcesses,
} from "../session-source.ts";
import type { SessionRecord } from "../source-records.ts";
import type { WorkflowRun } from "../workflow-source.ts";
import { makeRun } from "./model-fixtures.ts";

const fixtureIssue = 499;
function job(
  key: string,
  live = true,
  repo = "org/project-buddy",
): WorkflowRun {
  return makeRun(
    { stage: "review", launches: [{ key }] },
    { repo, issue: fixtureIssue, live },
  );
}
test("current verify is a positive PB gate observation, not an old scope", async () => {
  assert.deepEqual(capacity([job("verify-4")]).pbWeb, [fixtureIssue]);
  assert.deepEqual(
    capacity([job("verify-4", false), job("verify-4", true, "org/ecosystem")])
      .pbWeb,
    [],
  );
  const run = job("reviewer-5");
  run.data.launches.unshift({ key: "verify-4", scope: "pb-web" });
  assert.deepEqual(capacity([run]).pbWeb, []);
  assert.deepEqual(
    await observeWebGate([job("verify-4")], () => Promise.resolve("")),
    { issues: [fixtureIssue], busy: true },
  );
  const reviewer = {
    ...job("reviewer-2"),
    dir: fileURLToPath(new URL("./fixtures/gate", import.meta.url)),
  };
  assert.deepEqual(
    await observeWebGate([reviewer], () => Promise.resolve("")),
    { issues: [fixtureIssue], busy: true },
  );
  const processText = `123 node ${join(homedir(), ".pi/agent/issue-pipeline/work/axolotl-logic-io__project-buddy/issue-499/node_modules/vitest/index.js")}`;
  assert.deepEqual(
    await observeWebGate([], () => Promise.resolve(processText)),
    { issues: [fixtureIssue], busy: true },
  );
});
test("reviewer gate requires a currently open bash gate call; completed calls disappear", () => {
  const start: SessionRecord = {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "gate",
          name: "bash",
          arguments: { command: "npm run gate:web" },
        },
      ],
    },
  };
  assert.equal(runningGate([start]), true);
  assert.equal(
    runningGate([
      start,
      { type: "message", message: { role: "toolResult", toolCallId: "gate" } },
    ]),
    false,
  );
  assert.equal(
    runningGate([
      {
        ...start,
        message: {
          ...start.message,
          content: [
            {
              type: "toolCall",
              id: "read",
              name: "bash",
              arguments: { command: "git status" },
            },
          ],
        },
      },
    ]),
    false,
  );
});
test("process evidence must name a web runner AND a PB work path, with boundary", () => {
  const root = "/work/axolotl-logic-io__project-buddy";
  assert.equal(
    webProcesses(
      `123 node ${root}/issue-499/node_modules/.bin/vitest run`,
      root,
    ).length,
    1,
  );
  assert.equal(
    webProcesses(
      "123 node /other/project/node_modules/playwright/test.js",
      root,
    ).length,
    0,
  );
  assert.equal(
    webProcesses(`123 node ${root}-other/node_modules/vitest/run.js`, root)
      .length,
    0,
  );
  assert.equal(
    webProcesses(`123 git -C ${root}/issue-499 status`, root).length,
    0,
  );
});
