import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { HistoricalJob } from "../job-history.ts";
import { capacity } from "../legacy-capacity.ts";
import { observeWebGate } from "../session-source.ts";
import { makeRun } from "./model-fixtures.ts";

const fixtureIssue = 499;
function job(
  key: string,
  live = true,
  repo = "org/project-buddy",
): HistoricalJob {
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
