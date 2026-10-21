// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "../isolated-root-test-kit.mjs";

const { discoverAssignments } = await import("../../src/discovery/plan.ts");
const { world, fixture, SHA } = await import("./fake-github.mjs");
const { COMMENT } = await import("../../src/comments.ts");
const OTHER_PR = 3;
const SHA_LENGTH = 40;
const OTHER_REQUEST = 99;
const REVIEW_ID = 30;
const EXTRA_COMMENT = 12;
const UNAVAILABLE = 503;
const GRANT_ID = 20;

for (const actor of ["owner", "merge", "dev", "visitor", "revoked"]) {
  test(`assignment grants authenticate ${actor} through GitHub events`, async () => {
    const hub = world();
    const [event] = hub.events;
    assert.ok(event);
    event.actor = { login: actor };
    if (actor === "revoked") {
      hub.config.repositories[0]?.allowedUsers.push("revoked");
    }
    const plan = await discoverAssignments(hub.config, hub);
    assert.equal(
      plan.candidates.length,
      Number(actor === "owner" || actor === "merge"),
    );
    assert.equal(
      plan.holds[0]?.reason === "provenance",
      !(actor === "owner" || actor === "merge"),
    );
  });
}

for (const [mismatch, reason] of Object.entries({
  reviewer: "scope",
  author: "scope",
  pr: "scope",
  revision: "scope",
  absent: "scope",
  request: "scope",
  edited: "provenance",
  legacy: "state",
  malformed: "state",
  inputs: "inputs",
})) {
  test(`holds development review requests with ${mismatch} mismatch`, async () => {
    const hub = world();
    hub.assigned.length = 0;
    hub.pulls.push(hub.pull);
    if (mismatch === "reviewer") {
      hub.config.workers[0] = {
        repository: hub.repository,
        login: "dev",
        worker: "builder",
        roles: ["development"],
        reviewer: "other",
      };
    }
    if (mismatch === "author") {
      hub.pull.user.login = "visitor";
    }
    if (mismatch === "pr") {
      hub.handoff.checkpoint.pr = OTHER_PR;
    }
    if (mismatch === "revision") {
      hub.handoff.checkpoint.code = "b".repeat(SHA_LENGTH);
    }
    if (mismatch === "request") {
      hub.handoff.request = OTHER_REQUEST;
    }
    if (mismatch === "inputs") {
      hub.issue.title = "New requirements";
    }
    hub.save();
    if (mismatch === "absent") {
      hub.save(hub.state);
    }
    if (mismatch === "legacy") {
      hub.save({ ...hub.state, version: 1 });
    }
    if (mismatch === "malformed") {
      hub.save({ ...hub.state, asked: "forged" });
    }
    if (mismatch === "edited") {
      const saved = COMMENT.parse(hub.comments[0]);
      saved.lastEditedAt = "2026-10-20T03:00:00Z";
      saved.editor = { login: "visitor" };
      hub.comments[0] = saved;
    }
    const plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.holds[0]?.reason, reason);
  });
}

test("bound merge reviews are evidence only for their recorded PR and revision", async () => {
  const hub = world();
  hub.assigned.length = 0;
  hub.pulls.push(hub.pull);
  hub.handoff.review = REVIEW_ID;
  hub.save();
  const review = {
    id: 30,
    user: { login: "merge" },
    state: "APPROVED",
    commitId: SHA,
    submittedAt: "2026-10-20T02:00:00Z",
    pullRequestUrl: `https://api.github.com/repos/${hub.repository}/pulls/2`,
  };
  hub.reviews.push(review);
  let plan = await discoverAssignments(hub.config, hub);
  assert.deepEqual(plan.candidates[0]?.reviews, [REVIEW_ID]);
  assert.equal(plan.executionAuthority, false);
  hub.reviews.splice(0, 1, { ...review, commitId: "b".repeat(SHA_LENGTH) });
  plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.holds[0]?.reason, "provenance");
  hub.reviews.splice(0, 1, {
    ...review,
    pullRequestUrl: `https://api.github.com/repos/${hub.repository}/pulls/3`,
  });
  plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
});

test("unverifiable evidence has stable deduplication identities and no writes", async () => {
  const hub = world();
  hub.events.length = 0;
  const first = await discoverAssignments(hub.config, hub);
  const second = await discoverAssignments(hub.config, hub);
  assert.equal(
    first.holds[0]?.deduplicationKey,
    second.holds[0]?.deduplicationKey,
  );
  assert.equal(first.holds[0]?.repository, hub.repository);
  assert.equal(first.holds[0]?.number, 1);
  assert.equal(first.holds[0]?.incomplete, true);
});

test("bot, visitor and recognized legacy comments cannot answer questions or move input revisions", async () => {
  const hub = world();
  hub.state.stage = "implement";
  hub.state.asked = { inputs: hub.revision };
  hub.save(hub.state);
  for (const login of ["dev", "merge", "visitor", "legacy"]) {
    const comment = COMMENT.parse(fixture.comment);
    comment.id = hub.comments.length + EXTRA_COMMENT;
    comment.user = { login };
    comment.body =
      "<!-- agent-pipeline:comment role=author -->\nHere are my requirements";
    // Merge comments use the same-read query; give this one an independent node.
    comment.node_id = `extra-${comment.id}`;
    hub.comments.push(comment);
  }
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.holds[0]?.reason, "needs-info");
  assert.equal(plan.holds[0]?.evidence, `unanswered:${hub.revision}`);
});

test("trusted input changes return development to Author and do not offer review", async () => {
  const hub = world();
  hub.state.stage = "implement";
  hub.save(hub.state);
  hub.issue.title = "Changed trusted title";
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates[0]?.stage, "author");
  assert.notEqual(plan.candidates[0]?.inputs, hub.revision);
});

for (const control of [
  "stop",
  "dependency",
  "unreadable-dependency",
  "needs-info",
  "role",
]) {
  test(`assignment preserves ${control} control`, async () => {
    const hub = world();
    if (control === "stop") {
      hub.issue.labels.push({ name: "agent:stopped-ci" });
    }
    if (control === "needs-info") {
      hub.state.asked = { inputs: hub.revision };
      hub.save(hub.state);
    }
    if (control === "role") {
      hub.save(hub.state);
    }
    if (control.includes("dependency")) {
      hub.issue.body += "\n<!-- agent-pipeline:after 3 -->";
      let status = 200;
      if (control === "unreadable-dependency") {
        status = UNAVAILABLE;
      }
      hub.replies.set(`/repos/${hub.repository}/issues/3`, {
        status,
        body: { ...hub.issue, number: 3 },
        link: null,
      });
    }
    const plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.candidates.length, 0);
    assert.ok(plan.holds.length > 0);
    assert.equal(plan.complete, control !== "unreadable-dependency");
  });
}

test("normalizes actual GitHub REST wire names", async () => {
  const hub = world();
  hub.replies.set(
    `/repos/${hub.repository}/issues?state=open&assignee=*&per_page=100&page=1`,
    { status: 200, body: [fixture.issue], link: null },
  );
  hub.replies.set(
    `/repos/${hub.repository}/issues/1/events?per_page=100&page=1`,
    { status: 200, body: [fixture.event], link: null },
  );
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates[0]?.inputs, hub.revision);
  assert.equal(plan.candidates[0]?.grant, GRANT_ID);
  assert.equal(plan.executionAuthority, false);
});
