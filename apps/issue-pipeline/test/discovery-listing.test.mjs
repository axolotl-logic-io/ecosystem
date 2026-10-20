// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { discoverAssignments } = await import("../src/discovery/plan.ts");
const { world } = await import("./discovery/fake-github.mjs");

for (const repository of [
  "axolotl-logic-io/ecosystem",
  "axolotl-logic-io/project-buddy",
]) {
  test(`discovers authenticated development and scoped review in ${repository}`, async () => {
    const hub = world(repository);
    let plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.complete, true);
    assert.equal(plan.executionAuthority, false);
    assert.equal(plan.candidates[0]?.worker, "builder");
    assert.equal(plan.candidates[0]?.stage, "author");
    const priorRequests = hub.requests.length;
    hub.assigned.length = 0;
    hub.pulls.push(hub.pull);
    hub.save();
    const before = JSON.stringify([
      hub.config,
      hub.state,
      hub.comments,
      hub.pull,
    ]);
    plan = await discoverAssignments(hub.config, hub);
    assert.deepEqual(plan.holds, []);
    assert.equal(plan.candidates[0]?.worker, "checker");
    assert.equal(plan.candidates[0]?.role, "review");
    assert.equal(
      JSON.stringify([hub.config, hub.state, hub.comments, hub.pull]),
      before,
    );
    assert.equal(plan.requests, hub.requests.length - priorRequests);
  });
}

test("explicit opt-in and valid configuration are required before any read", async () => {
  const hub = world();
  await assert.rejects(
    discoverAssignments({ ...hub.config, enabled: false }, hub),
  );
  await assert.rejects(
    discoverAssignments({ ...hub.config, requestBudget: 0 }, hub),
  );
  await assert.rejects(discoverAssignments(undefined, hub));
  await assert.rejects(
    discoverAssignments(
      {
        ...hub.config,
        repositories: hub.config.repositories.map((repo) => ({
          ...repo,
          allowedUsers: [],
        })),
      },
      hub,
    ),
  );
  assert.equal(hub.requests.length, 0);
});

for (const mode of [
  "repository",
  "missing",
  "ambiguous",
  "worker-conflict",
  "role",
]) {
  test(`fails closed on ${mode} mapping boundaries`, async () => {
    const hub = world();
    if (mode === "repository") {
      hub.config.allowRepositories = [];
    }
    if (mode === "missing") {
      hub.config.workers = [];
    }
    if (mode === "ambiguous") {
      hub.config.workers.push({
        repository: hub.repository,
        login: "DEV",
        worker: "another",
        roles: ["development"],
      });
    }
    if (mode === "worker-conflict") {
      hub.config.workers.push({
        repository: hub.repository,
        login: "another",
        worker: "builder",
        roles: ["development"],
      });
    }
    if (mode === "role") {
      hub.config.workers = [
        {
          repository: hub.repository,
          login: "dev",
          worker: "builder",
          roles: ["review"],
        },
      ];
    }
    const plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.candidates.length, 0);
    let reason = "mapping";
    if (mode === "repository") {
      reason = "repository";
    }
    if (mode === "role") {
      reason = "role";
    }
    assert.equal(plan.holds[0]?.reason, reason);
    assert.equal(plan.requests === 0, mode === "repository");
  });
}

for (const kind of ["issues", "pulls"]) {
  test(`includes ${kind} from the second page`, async () => {
    const hub = world();
    let query = "state=open&assignee=*";
    let first = { ...hub.issue, assignees: [] };
    let second = hub.issue;
    if (kind === "pulls") {
      hub.assigned.length = 0;
      hub.save();
      query = "state=open";
      // Both records are valid GitHub shapes, but only page two is mapped work.
      hub.replies.set(
        `/repos/${hub.repository}/pulls?${query}&per_page=100&page=1`,
        {
          status: 200,
          body: [{ ...hub.pull, number: 3, requestedReviewers: [] }],
          link: `<https://api.github.com/repos/${hub.repository}/pulls?${query}&per_page=100&page=2>; rel="next"`,
        },
      );
      hub.replies.set(
        `/repos/${hub.repository}/pulls?${query}&per_page=100&page=2`,
        { status: 200, body: [hub.pull], link: null },
      );
    } else {
      first = { ...first, number: 3 };
      second = hub.issue;
      hub.replies.set(
        `/repos/${hub.repository}/issues?${query}&per_page=100&page=1`,
        {
          status: 200,
          body: [first],
          link: `<https://api.github.com/repos/${hub.repository}/issues?${query}&per_page=100&page=2>; rel="next"`,
        },
      );
      hub.replies.set(
        `/repos/${hub.repository}/issues?${query}&per_page=100&page=2`,
        { status: 200, body: [second], link: null },
      );
    }
    const plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.complete, true);
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0]?.kind, kind.slice(0, -1));
    assert.equal(
      hub.requests.some(
        (request) => request.kind === "rest" && request.path.endsWith("page=2"),
      ),
      true,
    );
  });
}

for (const failure of ["budget", "unreadable", "malformed", "missing-event"]) {
  test(`reports ${failure} as incomplete, never as authoritative emptiness`, async () => {
    const hub = world();
    if (failure === "budget") {
      hub.config.requestBudget = 1;
    }
    if (failure === "unreadable") {
      hub.replies.set(
        `/repos/${hub.repository}/issues?state=open&assignee=*&per_page=100&page=1`,
        { status: 503, body: [], link: null },
      );
    }
    if (failure === "malformed") {
      hub.replies.set(
        `/repos/${hub.repository}/issues?state=open&assignee=*&per_page=100&page=1`,
        { status: 200, body: [{ number: 1 }], link: null },
      );
    }
    if (failure === "missing-event") {
      hub.events.length = 0;
    }
    const plan = await discoverAssignments(hub.config, hub);
    assert.equal(plan.complete, false);
    assert.equal(plan.candidates.length, 0);
    assert.ok(plan.continuations.length > 0);
    assert.ok(plan.requests <= hub.config.requestBudget);
    assert.equal(plan.requests, hub.requests.length);
  });
}

test("a fully read empty queue is complete", async () => {
  const hub = world();
  hub.assigned.length = 0;
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.complete, true);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.continuations, []);
  assert.equal(plan.requests, 2);
});

test("identity matching is case-insensitive across mappings and authenticated actors", async () => {
  const hub = world();
  hub.config.allowRepositories = [hub.repository.toUpperCase()];
  for (const worker of hub.config.workers) {
    worker.repository = worker.repository.toUpperCase();
    worker.login = worker.login.toUpperCase();
    if (worker.reviewer !== undefined) {
      worker.reviewer = worker.reviewer.toUpperCase();
    }
  }
  const [repo] = hub.config.repositories;
  assert.ok(repo);
  repo.devAccount = "DEV";
  repo.mergeAccount = "MERGE";
  repo.allowedUsers = repo.allowedUsers.map((login) => login.toUpperCase());
  let plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates[0]?.worker, "builder");
  assert.deepEqual(plan.holds, []);
  hub.assigned.length = 0;
  hub.pulls.push(hub.pull);
  hub.save();
  plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates[0]?.worker, "checker");
  assert.deepEqual(plan.holds, []);
});

test("identical duplicate mappings cannot be resolved by first-match ordering", async () => {
  const hub = world();
  const [worker] = hub.config.workers;
  assert.ok(worker);
  hub.config.workers.push({ ...worker });
  const plan = await discoverAssignments(hub.config, hub);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.holds[0]?.reason, "mapping");
});
