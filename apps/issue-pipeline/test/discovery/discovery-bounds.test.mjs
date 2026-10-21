// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "../isolated-root-test-kit.mjs";

const { discoverAssignments } = await import("../../src/discovery/plan.ts");
const { world, fixture } = await import("./fake-github.mjs");
const { COMMENT } = await import("../../src/comments.ts");
const PAGE_SIZE = 100;
const UNAVAILABLE = 503;
const REVIEW_ID = 30;

for (const kind of ["issues", "pulls"]) {
  for (const failure of ["budget", "page", "link", "partial"]) {
    test(`${kind} ${failure} between pages is an incomplete listing`, async () => {
      const hub = world();
      let query = "state=open&assignee=*";
      let row = fixture.issue;
      if (kind === "pulls") {
        query = "state=open";
        row = fixture.pull;
      }
      const path = `/repos/${hub.repository}/${kind}?${query}&per_page=${PAGE_SIZE}&page=`;
      hub.replies.set(`${path}1`, {
        status: 200,
        body: [row],
        link: `<https://api.github.com${path}2>; rel="next"`,
      });
      if (failure === "budget") {
        hub.config.requestBudget = 1;
        if (kind === "pulls") {
          hub.config.requestBudget = 2;
        }
      }
      if (failure === "page") {
        hub.replies.set(`${path}2`, {
          status: UNAVAILABLE,
          body: [],
          link: null,
        });
      }
      if (failure === "partial") {
        hub.replies.set(`${path}2`, { status: 200, body: [null], link: null });
      }
      if (failure === "link") {
        hub.replies.set(`${path}1`, {
          status: 200,
          body: [row],
          link: "invalid header",
        });
      }
      const plan = await discoverAssignments(hub.config, hub);
      assert.equal(plan.complete, false);
      assert.ok(plan.continuations.some((hold) => hold.kind === "snapshot"));
      assert.ok(plan.requests <= hub.config.requestBudget);
      assert.equal(plan.requests, hub.requests.length);
      assert.equal(
        plan.candidates.some((candidate) => `${candidate.kind}s` === kind),
        false,
      );
    });
  }
}

for (const evidence of [
  "comments",
  "events",
  "collaboration",
  "review",
  "editor",
]) {
  test(`missing ${evidence} reads never grant eligibility`, async () => {
    const hub = world();
    let path = `/repos/${hub.repository}/issues/1/comments?per_page=${PAGE_SIZE}&page=1`;
    if (evidence === "events") {
      path = `/repos/${hub.repository}/issues/1/events?per_page=${PAGE_SIZE}&page=1`;
    }
    if (evidence === "collaboration") {
      path = `/repos/${hub.repository}/collaborators/owner`;
    }
    if (evidence === "review") {
      hub.assigned.length = 0;
      hub.pulls.push(hub.pull);
      hub.save();
      path = `/repos/${hub.repository}/pulls/2/reviews?per_page=${PAGE_SIZE}&page=1`;
    }
    hub.replies.set(path, { status: UNAVAILABLE, body: null, link: null });
    if (evidence === "editor") {
      hub.replies.clear();
      const saved = COMMENT.parse(fixture.comment);
      saved.node_id = undefined;
      hub.comments.push(saved);
    }
    const plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.complete, false);
    assert.ok(plan.continuations.length > 0);
  });
}

test("a full page without Link metadata requires another bounded read", async () => {
  const hub = world();
  const first = Array.from({ length: PAGE_SIZE }, (_value, index) => ({
    ...hub.issue,
    number: index + 1,
    assignees: [],
  }));
  hub.replies.set(
    `/repos/${hub.repository}/issues?state=open&assignee=*&per_page=${PAGE_SIZE}&page=1`,
    { status: 200, body: first, link: null },
  );
  hub.replies.set(
    `/repos/${hub.repository}/issues?state=open&assignee=*&per_page=${PAGE_SIZE}&page=2`,
    { status: 200, body: [], link: null },
  );
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.complete, true);
  assert.ok(
    hub.requests.some(
      (request) =>
        request.kind === "rest" &&
        new URL(request.path, "https://api.github.com").searchParams.get(
          "page",
        ) === "2",
    ),
  );
  assert.ok(plan.requests <= hub.config.requestBudget);
  assert.deepEqual(plan.holds, []);
});

test("revoked issue authors cannot grant work even through merge orchestration", async () => {
  const hub = world();
  hub.collaborators.clear();
  const [event] = hub.events;
  assert.ok(event);
  event.actor = { login: "merge" };
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.holds[0]?.reason, "provenance");
});

test("a current reviewer list alone cannot establish a handoff", async () => {
  const hub = world();
  hub.assigned.length = 0;
  hub.pulls.push(hub.pull);
  hub.save();
  hub.reviewEvents.length = 0;
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.complete, false);
  assert.equal(plan.holds[0]?.reason, "provenance");
});

test("extra team requests cannot enlarge development's reviewer scope", async () => {
  const hub = world();
  hub.assigned.length = 0;
  hub.pulls.push(hub.pull);
  hub.pull.requestedTeams.push({ slug: "other-team" });
  hub.save();
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.holds[0]?.reason, "scope");
});

test("recorded review evidence absent from GitHub remains incomplete", async () => {
  const hub = world();
  hub.assigned.length = 0;
  hub.pulls.push(hub.pull);
  hub.handoff.review = REVIEW_ID;
  hub.save();
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.complete, false);
  assert.equal(plan.holds[0]?.reason, "provenance");
});

test("open parents are relationships, closed after markers satisfy prerequisites", async () => {
  const hub = world();
  hub.issue.body +=
    "\n<!-- agent-pipeline:parent 3 depth 1 -->\n<!-- agent-pipeline:after 4 -->";
  hub.replies.set(`/repos/${hub.repository}/issues/3`, {
    status: 200,
    body: { ...hub.issue, number: 3 },
    link: null,
  });
  hub.replies.set(`/repos/${hub.repository}/issues/4`, {
    status: 200,
    body: { ...hub.issue, number: 4, state: "closed" },
    link: null,
  });
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 1);
  assert.deepEqual(plan.holds, []);
});
