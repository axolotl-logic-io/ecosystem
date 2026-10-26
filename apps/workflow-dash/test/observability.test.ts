import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { observeWebGate } from "../session-source.ts";

const fixtureIssue = 499;
const work = join(
  homedir(),
  ".pi/agent/issue-pipeline/work/axolotl-logic-io__project-buddy",
);

test("a web runner in a Project Buddy checkout is a positive pb-web observation", async () => {
  const processText = `123 node ${join(work, `issue-${fixtureIssue}/node_modules/vitest/index.js`)}`;
  assert.deepEqual(await observeWebGate(() => Promise.resolve(processText)), {
    issues: [fixtureIssue],
    busy: true,
  });
  const elsewhere = `124 node /tmp/issue-${fixtureIssue}/node_modules/vitest/index.js\n125 grep vitest ${work}/issue-7`;
  assert.deepEqual(await observeWebGate(() => Promise.resolve(elsewhere)), {
    issues: [],
    busy: false,
  });
});
