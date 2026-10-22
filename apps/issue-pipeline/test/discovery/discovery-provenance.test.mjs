// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "../isolated-root-test-kit.mjs";

const { discoverAssignments } = await import("../../src/discovery/plan.ts");
const { world, fixture } = await import("./fake-github.mjs");
const { COMMENT } = await import("../../src/comments.ts");
const NEW_EVENT = 22;
const NEW_COMMENT = 15;
const PAGE_SIZE = 100;

for (const actor of ["owner", "merge", "dev", "revoked"]) {
  test(`review grants authenticate ${actor} with a recorded handoff`, async () => {
    const hub = world();
    hub.assigned.length = 0;
    hub.pulls.push(hub.pull);
    hub.save();
    const [event] = hub.reviewEvents;
    assert.ok(event);
    event.actor = { login: actor };
    hub.config.repositories[0]?.allowedUsers.push("revoked");
    const plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.candidates.length, Number(actor !== "revoked"));
    assert.equal(plan.executionAuthority, false);
  });
}

test("a later removal contradicts a current assignee list", async () => {
  const hub = world();
  const [event] = hub.events;
  assert.ok(event);
  hub.events.push({ ...event, id: NEW_EVENT, event: "unassigned" });
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.holds[0]?.reason, "provenance");
});

test("a malformed later grant cannot fall back to an earlier valid grant", async () => {
  const hub = world();
  hub.replies.set(
    `/repos/${hub.repository}/issues/1/events?per_page=${PAGE_SIZE}&page=1`,
    {
      status: 200,
      body: [
        ...hub.events,
        {
          id: NEW_EVENT,
          event: "assigned",
          actor: { login: "owner" },
          createdAt: "2026-10-20T02:00:00Z",
        },
      ],
      link: null,
    },
  );
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.complete, false);
  assert.equal(plan.holds[0]?.reason, "page");
});

test("duplicate work across pages cannot masquerade as a complete snapshot", async () => {
  const hub = world();
  hub.replies.set(
    `/repos/${hub.repository}/issues?state=open&assignee=*&per_page=${PAGE_SIZE}&page=1`,
    { status: 200, body: [hub.issue, hub.issue], link: null },
  );
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.complete, false);
});

test("only current collaborators' human comments move the existing input hash", async () => {
  const hub = world();
  hub.state.stage = "implement";
  hub.save(hub.state);
  const comment = COMMENT.parse(fixture.comment);
  comment.id = NEW_COMMENT;
  comment.user = { login: "person" };
  comment.body = "New human requirements";
  hub.config.repositories[0]?.allowedUsers.push("person");
  hub.comments.push(comment);
  let plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates[0]?.inputs, hub.revision);
  assert.equal(plan.candidates[0]?.stage, "implement");
  hub.collaborators.add("person");
  plan = await discoverAssignments(hub.config, hub);
  assert.notEqual(plan.candidates[0]?.inputs, hub.revision);
  assert.equal(plan.candidates[0]?.stage, "author");
});

test("same-read comment body replaces stale REST state before parsing", async () => {
  const hub = world();
  hub.state.stage = "implement";
  hub.save(hub.state);
  const reader = {
    /** @param {import('../../src/discovery/reads.ts').ReadRequest} request */
    read: async (request) => {
      const reply = await hub.read(request);
      if (request.kind === "comment" && request.id === "state") {
        return {
          status: 200,
          link: null,
          body: {
            data: {
              node: {
                databaseId: 10,
                body: "<!-- agent-pipeline:state\n{}\n-->",
                author: { login: "merge" },
                createdAt: "2026-10-20T00:00:00Z",
                updatedAt: "2026-10-20T00:00:00Z",
                lastEditedAt: null,
                editor: null,
              },
            },
          },
        };
      }
      return reply;
    },
  };
  const plan = await discoverAssignments(hub.config, reader);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.holds[0]?.reason, "state");
});
