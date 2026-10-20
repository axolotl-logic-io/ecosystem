// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";
import { coordination } from "../src/coordination.ts";
import { refOf } from "../src/coordination-records.ts";
import { world } from "./coordination-test-kit.mjs";

const HELD = /reconciliation|uncertain/u;
/** @type {("request" | "confirm" | "save" | "release" | "cancel")[]} */
const TRANSITIONS = ["request", "confirm", "save", "release", "cancel"];

for (const transition of TRANSITIONS) {
  for (const invalid of [
    "author",
    "editor",
    "missing provenance",
    "linkage",
    "malformed",
  ]) {
    test(`${transition} rejects ${invalid} evidence without rewriting history`, () => {
      const github = world();
      const a = github.guard();
      a.request();
      let acquired = true;
      if (transition === "cancel") {
        a.cancel();
      } else if (transition !== "request") {
        acquired = a.acquire();
        if (transition === "save") {
          a.save({ stage: "review" });
        } else if (transition === "release") {
          a.release();
        }
      }
      assert.equal(acquired, true);
      const record = github.comments.at(-1);
      assert.ok(record);
      if (invalid === "author") {
        record.user = { login: "visitor" };
      } else if (invalid === "editor") {
        record.lastEditedAt = "2026-10-20T00:00:00Z";
        record.editor = { login: "visitor" };
      } else if (invalid === "missing provenance") {
        record.editor = undefined;
      } else if (invalid === "linkage") {
        if (transition === "request") {
          record.body = record.body?.replace(
            github.cfg.baseBranch,
            "wrong-base",
          );
        } else {
          record.body = record.body?.replace('"request":1', '"request":999');
        }
      } else {
        record.body = "<!-- agent-pipeline:coordination\n{broken\n-->";
      }
      const history = structuredClone(github.comments);
      const refs = new Map(github.locks);
      const writes = [...github.writes];
      assert.throws(() => a.read(), HELD);
      assert.throws(() => a.save({ stage: "done" }), HELD);
      assert.throws(() => github.guard("B").request(), HELD);
      assert.deepEqual(github.comments, history);
      assert.deepEqual(github.locks, refs);
      assert.deepEqual(github.writes, writes);
    });
  }
}

test("request and successful immutable reservation alone cannot save or release", () => {
  const github = world();
  const a = github.guard();
  a.request();
  assert.throws(() => a.save({ stage: "review" }), HELD);
  assert.throws(() => a.release(), HELD);
  const [request] = a.read().pending;
  assert.ok(request);
  github.port.reserve(refOf("issue", 0), request.token);
  assert.equal(a.read().confirmed, false);
  const history = structuredClone(github.comments);
  assert.throws(() => a.save({ stage: "review" }), HELD);
  assert.throws(() => a.release(), HELD);
  assert.deepEqual(github.comments, history);
  assert.equal(a.acquire(), true);
  a.assertOwner();
});

for (const scope of ["issue", "integration"]) {
  test(`${scope} cancellation removes only its exact pending request in durable order`, () => {
    const github = world();
    const a = github.guard("A", scope);
    const b = github.guard("B", scope);
    const c = github.guard("C", scope);
    const d = github.guard("D", scope);
    a.request();
    b.request();
    const cId = c.request();
    const dId = d.request();
    assert.equal(a.acquire(), true);
    const before = structuredClone(github.comments);
    const refs = new Map(github.locks);
    b.cancel();
    assert.deepEqual(github.comments.slice(0, before.length), before);
    assert.deepEqual(github.locks, refs);
    a.assertOwner();
    assert.throws(() => a.cancel(), HELD);
    a.release();
    assert.deepEqual(
      c.read().pending.map((request) => request.id),
      [cId, dId],
    );
    assert.equal(c.acquire(), true);
    const successor = structuredClone(github.comments);
    const successorRefs = new Map(github.locks);
    assert.throws(() => a.save({ stale: true }), HELD);
    assert.throws(() => a.release(), HELD);
    assert.throws(() => b.release(), HELD);
    assert.deepEqual(github.comments, successor);
    assert.deepEqual(github.locks, successorRefs);
    assert.deepEqual(
      c.read().pending.map((request) => request.id),
      [cId, dId],
    );
    c.assertOwner();
  });
}

test("a reused UUID with a changed lane, branch or issue cannot acquire or cancel", () => {
  const github = world();
  const a = github.guard();
  a.request();
  for (const change of [
    { lane: "other" },
    { branch: "other" },
    { issue: github.issue + 1 },
  ]) {
    const spoof = coordination(github.cfg, github.port, "issue", {
      ...github.identity("A"),
      ...change,
    });
    const before = structuredClone(github.comments);
    assert.throws(() => spoof.acquire(), HELD);
    assert.throws(() => spoof.cancel(), HELD);
    assert.deepEqual(github.comments, before);
  }
});
