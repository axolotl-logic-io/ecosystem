// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";
import { coordination } from "../src/coordination.ts";
import { bodyOf } from "../src/coordination-records.ts";
import { world } from "./coordination-test-kit.mjs";

const HELD = /reconciliation|uncertain/u;

for (const transition of ["read", "save", "release"]) {
  test(`a ref changing after confirmation cannot transfer authority through ${transition}`, () => {
    const github = world();
    const a = github.guard("A");
    const b = github.guard("B");
    a.request();
    const bId = b.request();
    assert.equal(a.acquire(), true);
    const request = b.read().pending.find((row) => row.id === bId);
    assert.ok(request);
    const before = structuredClone(github.comments);
    const refs = new Map(github.locks);
    const writes = [...github.writes];
    let reads = 0;
    const inconsistent = coordination(
      github.cfg,
      {
        ...github.port,
        lock: (ref) => {
          reads += 1;
          // The confirmation is read against A, then the same epoch ref
          // contradicts it. B has never had an authenticated confirmation.
          if (reads === 1) {
            return github.port.lock(ref);
          }
          return request.token;
        },
      },
      github.scope(),
      github.identity("B"),
    );
    assert.throws(() => {
      if (transition === "read") {
        inconsistent.assertOwner();
      } else if (transition === "save") {
        inconsistent.save({ stage: "review" });
      } else {
        inconsistent.release();
      }
    }, HELD);
    assert.deepEqual(github.comments, before);
    assert.deepEqual(github.locks, refs);
    assert.deepEqual(github.writes, writes);
    a.assertOwner();
    assert.equal(b.acquire(), false);
  });
}

test("conflicting reservation read-back holds before appending an owner confirmation", () => {
  const github = world();
  const a = github.guard("A");
  const b = github.guard("B");
  a.request();
  const bId = b.request();
  const request = b.read().pending.find((row) => row.id === bId);
  assert.ok(request);
  const history = structuredClone(github.comments);
  const conflicting = coordination(
    github.cfg,
    {
      ...github.port,
      write: (operation, write, confirmed, evidence) => {
        github.port.write(operation, write, confirmed, evidence);
        if (operation === "acquire") {
          for (const ref of github.locks.keys()) {
            github.locks.set(ref, request.token);
          }
        }
      },
    },
    github.scope(),
    github.identity("A"),
  );
  assert.throws(() => conflicting.acquire(), HELD);
  assert.deepEqual(github.comments, history);
  assert.deepEqual([...github.locks.values()], [request.token]);
  assert.equal(b.read().confirmed, false);
  assert.throws(() => b.assertOwner(), HELD);
});

for (const binding of ["issue", "branch", "repo", "base"]) {
  test(`an authenticated request with a mismatched ${binding} cannot enter an issue scope`, () => {
    const github = world();
    const a = github.guard();
    a.request();
    const [request] = a.read().pending;
    const [comment] = github.comments;
    assert.ok(request);
    assert.ok(comment);
    const { id: _id, ...record } = request;
    const identity = { ...request.identity };
    if (binding === "issue") {
      identity.issue += 1;
    } else if (binding === "branch") {
      identity.branch = "other/branch";
    } else if (binding === "repo") {
      identity.repo = "other/repo";
    } else {
      identity.base = "other-base";
    }
    comment.body = bodyOf({ ...record, identity });
    const before = structuredClone(github.comments);
    const writes = [...github.writes];
    assert.throws(() => a.read(), HELD);
    assert.throws(() => a.acquire(), HELD);
    assert.throws(() => a.cancel(), HELD);
    assert.throws(() => a.save({ stage: "review" }), HELD);
    assert.throws(() => a.release(), HELD);
    assert.deepEqual(github.comments, before);
    assert.deepEqual(github.writes, writes);
    assert.throws(
      () => coordination(github.cfg, github.port, github.scope(), identity),
      HELD,
    );
  });
}

for (const kind of ["confirm", "save", "release", "cancel"]) {
  test(`a ${kind} cannot hide invalid linkage by changing to another valid scope`, () => {
    const github = world();
    const a = github.guard();
    a.request();
    let acquired = true;
    if (kind === "cancel") {
      a.cancel();
    } else {
      acquired = a.acquire();
      if (kind === "save") {
        a.save({ stage: "review" });
      } else if (kind === "release") {
        a.release();
      }
    }
    assert.equal(acquired, true);
    const record = a.read().records.at(-1);
    const comment = github.comments.at(-1);
    assert.ok(record);
    assert.ok(comment);
    assert.equal(record.kind, kind);
    const { id: _id, ...saved } = record;
    comment.body = bodyOf({ ...saved, scope: github.scope("integration") });
    const before = structuredClone(github.comments);
    const refs = new Map(github.locks);
    const writes = [...github.writes];
    assert.throws(() => a.read(), HELD);
    assert.throws(() => a.save({ stage: "done" }), HELD);
    assert.throws(() => github.guard("B").request(), HELD);
    assert.deepEqual(github.comments, before);
    assert.deepEqual(github.locks, refs);
    assert.deepEqual(github.writes, writes);
  });
}
