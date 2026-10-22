// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "../isolated-root-test-kit.mjs";

const { discoverAssignments } = await import("../../src/discovery/plan.ts");
const { world } = await import("./fake-github.mjs");

const INPUT_REVISION_LENGTH = 64;
for (const stale of [null, "a".repeat(INPUT_REVISION_LENGTH)]) {
  test(`authored discovery retains the saved-Gherkin revision guard for ${stale}`, async () => {
    const hub = world();
    assert.ok(hub.state.gherkin);
    if (stale === null) {
      hub.state.gherkin = null;
    } else {
      hub.state.gherkin.inputs = stale;
    }
    hub.save();
    let plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.candidates[0]?.stage, "author");
    hub.assigned.length = 0;
    hub.pulls.push(hub.pull);
    plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.holds[0]?.reason, "inputs");
    assert.equal(plan.executionAuthority, false);
  });
}

test("direct discovery reviews current trusted requirements without a Gherkin comment and returns changed inputs to Developer", async () => {
  const hub = world();
  hub.state.authorUsed = false;
  hub.state.requirementsInputs = hub.revision;
  hub.state.gherkin = null;
  hub.save();
  hub.comments.splice(1);
  hub.assigned.length = 0;
  hub.pulls.push(hub.pull);
  let plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates[0]?.stage, "review");
  assert.deepEqual(plan.holds, []);
  hub.issue.title = "Changed trusted requirements";
  plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.holds[0]?.reason, "inputs");
  assert.ok(plan.holds[0]?.evidence.startsWith("return-to-implement:"));
  hub.pulls.length = 0;
  hub.assigned.push(hub.issue);
  plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates[0]?.stage, "implement");
  assert.equal(plan.executionAuthority, false);
});

for (const invalid of [
  { authorUsed: "false" },
  { authorUsed: null },
  { requirementsInputs: 42 },
  { requirementsInputs: "not-a-revision" },
]) {
  test(`discovery never normalizes malformed requirements authority ${JSON.stringify(invalid)}`, async () => {
    const hub = world();
    hub.save({ ...hub.state, ...invalid });
    const plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.holds[0]?.reason, "state");
    assert.equal(plan.executionAuthority, false);
  });
}
