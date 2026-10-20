// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { discoverAssignments } = await import("../src/discovery/plan.ts");
const { world } = await import("./discovery/fake-github.mjs");
const APP_EVENT = 25;

for (const kind of ["issue", "pull"]) {
  test(`unrelated GitHub App events do not hide authenticated ${kind} work`, async () => {
    const hub = world();
    let { events } = hub;
    if (kind === "pull") {
      hub.assigned.length = 0;
      hub.pulls.push(hub.pull);
      hub.save();
      events = hub.reviewEvents;
    }
    const [grant] = events;
    assert.ok(grant);
    events.push({
      ...grant,
      id: APP_EVENT,
      event: "labeled",
      actor: { login: "automation[bot]" },
    });
    const plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.complete, true);
    assert.equal(plan.candidates[0]?.kind, kind);
    assert.equal(plan.candidates[0]?.grant, grant.id);
    assert.deepEqual(plan.holds, []);
  });
}

test("a GitHub App login is not a trusted human or configured orchestrator", async () => {
  const hub = world();
  const [grant] = hub.events;
  assert.ok(grant);
  grant.actor = { login: "automation[bot]" };
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.complete, true);
  assert.equal(plan.holds[0]?.reason, "provenance");
});
