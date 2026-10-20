// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { discoverAssignments } = await import("../src/discovery/plan.ts");
const { world, fixture, SHA } = await import("./discovery/fake-github.mjs");
const { COMMENT } = await import("../src/comments.ts");
const PAGE_SIZE = 100;

for (const evidence of [
  "merge-comment",
  "legacy-comment",
  "merged-label",
  "merged-receipt",
  "security-receipt",
]) {
  test(`prior ${evidence} cannot be rediscovered as fresh development`, async () => {
    const hub = world();
    if (evidence.endsWith("comment")) {
      const comment = COMMENT.parse(fixture.comment);
      comment.body = "<!-- agent-pipeline:comment role=author -->\nPrior work";
      if (evidence === "legacy-comment") {
        comment.user = { login: "legacy" };
      }
      hub.comments.push(comment);
    }
    if (evidence === "merged-label") {
      hub.issue.labels.push({ name: "agent:merged" });
    }
    if (evidence.endsWith("receipt")) {
      hub.state.stage = "implement";
      const revision = { code: SHA, wiki: null, inputs: hub.revision };
      if (evidence === "merged-receipt") {
        hub.state.merged = revision;
      } else {
        hub.state.security = {
          revision,
          commentId: 30,
          finding: { category: "user-harm", reason: "Rejected result" },
        };
      }
      hub.save(hub.state);
    }
    const plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.complete, true);
    assert.ok(plan.holds.some((hold) => hold.number === 1));
  });
}

for (const kind of ["issues", "pulls"]) {
  for (const relation of ["last", "prev", "first"]) {
    test(`${kind} contradictory ${relation} pagination is incomplete`, async () => {
      const hub = world();
      let query = "state=open&assignee=*";
      if (kind === "pulls") {
        query = "state=open";
        hub.assigned.length = 0;
      }
      const path = `/repos/${hub.repository}/${kind}?${query}&per_page=${PAGE_SIZE}&page=`;
      hub.replies.set(`${path}1`, {
        status: 200,
        body: [],
        link: `<https://api.github.com${path}2>; rel="${relation}"`,
      });
      const plan = await discoverAssignments(hub.config, hub);
      assert.equal(plan.complete, false);
      assert.equal(plan.candidates.length, 0);
      assert.ok(plan.continuations.some((hold) => hold.reason === "page"));
      assert.ok(plan.requests <= hub.config.requestBudget);
    });
  }
}

test("unrelated historical team requests do not invalidate a scoped user grant", async () => {
  const hub = world();
  hub.assigned.length = 0;
  hub.pulls.push(hub.pull);
  hub.save();
  hub.replies.set(
    `/repos/${hub.repository}/issues/2/events?per_page=${PAGE_SIZE}&page=1`,
    {
      status: 200,
      body: [...hub.reviewEvents, fixture.teamEvent],
      link: null,
    },
  );
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.complete, true);
  assert.equal(plan.candidates[0]?.worker, "checker");
  assert.deepEqual(plan.holds, []);
});

test("a recorded request cannot also be recorded as predating its handoff", async () => {
  const hub = world();
  hub.assigned.length = 0;
  hub.pulls.push(hub.pull);
  assert.ok(hub.handoff.request !== null);
  hub.handoff.eventsBefore.push(hub.handoff.request);
  hub.save();
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.holds[0]?.reason, "scope");
});

for (const missing of ["body", "user"]) {
  test(`a comment page missing ${missing} cannot establish complete inputs`, async () => {
    const hub = world();
    const comment = COMMENT.parse(fixture.comment);
    comment.user = { login: "owner" };
    comment.body = "Human requirements";
    const incomplete = Object.fromEntries(
      Object.entries(comment).filter(([key]) => key !== missing),
    );
    hub.replies.set(
      `/repos/${hub.repository}/issues/1/comments?per_page=${PAGE_SIZE}&page=1`,
      {
        status: 200,
        body: [incomplete],
        link: null,
      },
    );
    const plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.complete, false);
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.continuations[0]?.number, 1);
    assert.equal(plan.continuations[0]?.reason, "page");
  });
}

test("a partial Link header cannot terminate a full listing page", async () => {
  const hub = world();
  const path = `/repos/${hub.repository}/issues?state=open&assignee=*&per_page=${PAGE_SIZE}&page=`;
  hub.replies.set(`${path}1`, {
    status: 200,
    body: Array.from({ length: PAGE_SIZE }, (_unused, index) => ({
      ...hub.issue,
      number: index + 2,
      assignees: [],
    })),
    link: `<https://api.github.com${path}1>; rel="first"`,
  });
  hub.replies.set(`${path}2`, { status: 200, body: [hub.issue], link: null });
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.complete, true);
  assert.equal(plan.candidates[0]?.number, 1);
  assert.deepEqual(plan.holds, []);
});

test("a full final page with coherent Link metadata is complete", async () => {
  const hub = world();
  const path = `/repos/${hub.repository}/issues?state=open&assignee=*&per_page=${PAGE_SIZE}&page=`;
  hub.replies.set(`${path}1`, {
    status: 200,
    body: Array.from({ length: PAGE_SIZE }, (_unused, index) => ({
      ...hub.issue,
      number: index + 1,
      assignees: [],
    })),
    link: `<https://api.github.com${path}1>; rel="last"`,
  });
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.complete, true);
  assert.equal(plan.requests, 2);
  assert.deepEqual(plan.holds, []);
});
