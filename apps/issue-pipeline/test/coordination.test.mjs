// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";
import { instanceId, world } from "./coordination-test-kit.mjs";

const DUPLICATE_ID = 100;
/** @param {ReturnType<ReturnType<typeof world>["guard"]>} guard @param {string} operation @returns {boolean} */
function prepare(guard, operation) {
  if (operation === "acquire") {
    return true;
  }
  return guard.acquire();
}
/** @param {ReturnType<ReturnType<typeof world>["guard"]>} guard @param {string} operation @returns {boolean} */
function operate(guard, operation) {
  if (operation === "acquire") {
    return guard.acquire();
  }
  if (operation === "save") {
    guard.save({ stage: "review" });
  } else {
    guard.release();
  }
  return true;
}
const RECONCILE = /reconciliation|uncertain/u;
for (const scope of ["issue", "integration"]) {
  for (const lane of ["same", "different"]) {
    test(`${scope}: two ${lane} lanes never share execution permission`, () => {
      const github = world();
      const a = github.guard("A", scope, "same");
      const b = github.guard("B", scope, lane);
      a.request();
      b.request();
      assert.equal(b.acquire(), false);
      assert.equal(a.acquire(), true);
      let models = 0;
      let mutations = 0;
      a.assertOwner();
      models += 1;
      a.assertOwner();
      mutations += 1;
      assert.throws(() => b.assertOwner(), RECONCILE);
      assert.equal(models, 1);
      assert.equal(mutations, 1);
      assert.equal(github.guard("B", scope, lane).acquire(), false);
    });
  }
  test(`${scope}: confirmed release preserves order and permits a new instance`, () => {
    const github = world();
    const a = github.guard("A", scope);
    a.request();
    assert.equal(a.acquire(), true);
    a.save({ stage: "review", preserved: "work" });
    a.release();
    const b = github.guard("B", scope);
    assert.throws(() => b.assertOwner(), RECONCILE);
    b.request();
    assert.equal(b.acquire(), true);
    b.save({ stage: "merge", preserved: "work" });
    const before = structuredClone(github.comments);
    for (const delayed of [
      () => a.release(),
      () => a.save({ heartbeat: "old" }),
      () => a.request(),
    ]) {
      assert.throws(delayed, RECONCILE);
    }
    assert.deepEqual(github.comments, before);
    b.assertOwner();
  });
  for (const evidence of ["uncertain mutation", "local recovery required"]) {
    test(`${scope}: expired heartbeat cannot resolve ${evidence}`, () => {
      const github = world();
      const a = github.guard("A", scope);
      a.request();
      assert.equal(a.acquire(), true);
      a.save({ heartbeat: "2000-01-01T00:00:00Z", unresolved: evidence });
      const before = structuredClone(github.comments);
      const b = github.guard("B", scope);
      b.request();
      assert.equal(b.acquire(), false);
      assert.deepEqual(github.comments.slice(0, before.length), before);
      assert.equal(b.read().owner?.identity.instance, instanceId("A"));
      assert.throws(() => b.assertOwner(), RECONCILE);
    });
  }
  for (const operation of ["acquire", "save", "release"]) {
    test(`${scope}: unknown ${operation} is journaled and never retried on restart`, () => {
      const github = world();
      const a = github.guard("A", scope);
      a.request();
      assert.equal(prepare(a, operation), true);
      github.uncertain(operation);
      assert.throws(() => {
        operate(a, operation);
      }, RECONCILE);
      const attempted = [...github.writes];
      const evidence = structuredClone(github.comments);
      assert.throws(() => a.assertOwner(), RECONCILE);
      assert.throws(() => github.guard("new", scope).request(), RECONCILE);
      assert.deepEqual(github.writes, attempted);
      assert.deepEqual(github.comments, evidence);
    });
    test(`${scope}: a lost ${operation} response needs exact read-back, not a retry`, () => {
      const github = world();
      const a = github.guard("A", scope);
      a.request();
      assert.equal(prepare(a, operation), true);
      github.loseResponse(operation);
      assert.equal(operate(a, operation), true);
      assert.equal(
        github.writes.filter((write) => write === operation).length,
        1,
      );
    });
  }
}

test("integration order is reconstructed from GitHub, not caller dispatch or a local queue", () => {
  const github = world();
  const a = github.guard("caller-job", "integration", "caller", 1);
  const b = github.guard("candidate", "integration", "assignment", 2);
  a.request();
  b.request();
  assert.equal(a.acquire(), true);
  assert.equal(b.acquire(), false);
  const durable = b.read();
  const restart = github.guard("candidate", "integration", "assignment", 2);
  assert.deepEqual(restart.read(), durable);
  a.release();
  assert.equal(restart.acquire(), true);
  assert.deepEqual(
    restart.read().pending.map((request) => request.identity.issue),
    [2],
  );
});

for (const condition of [
  "missing",
  "malformed",
  "foreign author",
  "foreign editor",
  "unreadable",
  "conflicting instance",
]) {
  test(`authority ${condition} never falls back to a permissive record`, () => {
    const github = world();
    const a = github.guard();
    a.request();
    assert.equal(a.acquire(), true);
    const [request] = github.comments;
    assert.ok(request);
    if (condition === "missing") {
      github.comments.splice(0, 1);
    } else if (condition === "malformed") {
      request.body = "<!-- agent-pipeline:coordination broken -->";
    } else if (condition === "foreign author") {
      request.user = { login: "visitor" };
    } else if (condition === "foreign editor") {
      request.lastEditedAt = "2026-10-20T00:00:00Z";
      request.editor = { login: "visitor" };
    } else if (condition === "unreadable") {
      github.unreadable();
    } else {
      const duplicate = structuredClone(request);
      duplicate.id = DUPLICATE_ID;
      github.comments.push(duplicate);
    }
    const writes = [...github.writes];
    assert.throws(() => a.assertOwner());
    assert.throws(() => a.save({ stage: "done" }));
    assert.deepEqual(github.writes, writes);
  });
}
