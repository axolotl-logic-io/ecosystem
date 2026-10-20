// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import "./isolated-root-test-kit.mjs";
import { paths } from "../src/config.ts";
import { coordination } from "../src/coordination.ts";
import { bodyOf, refOf } from "../src/coordination-records.ts";
import { world } from "./coordination-test-kit.mjs";

const HELD = /reconciliation|uncertain/u;
const SHA_WIDTH = 40;
const CONFIRM_INTENT = z.object({
  operation: z.literal("confirm"),
  evidence: z.string(),
});
test("an unlinked confirmation cannot establish exact authenticated write success", () => {
  const github = world();
  const a = github.guard();
  a.request();
  const [request] = a.read().pending;
  assert.ok(request);
  /** @type {import('../src/coordination-records.ts').Record} */
  const record = {
    version: 1,
    scope: "issue",
    operation: crypto.randomUUID(),
    kind: "confirm",
    request: request.id,
    instance: request.identity.instance,
  };
  // It is authored and exactly readable, but has no immutable epoch ref.
  assert.throws(
    () =>
      github.port.write(
        "confirm",
        () => github.port.append(bodyOf(record)),
        () => a.read().confirmed,
        bodyOf(record),
      ),
    HELD,
  );
  const journal = path.join(
    paths.runDir(github.cfg, github.issue),
    "coordination-uncertain.json",
  );
  assert.ok(fs.readFileSync(journal, "utf8").includes(record.operation));
  const writes = [...github.writes];
  assert.throws(() => a.acquire(), HELD);
  assert.deepEqual(github.writes, writes);
});

for (const operation of ["acquire", "save", "release"]) {
  test(`a rejected ${operation} retains the exact intent and does not retry`, () => {
    const github = world();
    const a = github.guard();
    a.request();
    let acquired = true;
    if (operation !== "acquire") {
      acquired = a.acquire();
    }
    assert.equal(acquired, true);
    const before = structuredClone(github.comments);
    const refs = new Map(github.locks);
    const port = {
      ...github.port,
      append: () => {
        throw new Error("write rejected");
      },
      reserve: () => {
        throw new Error("write rejected");
      },
    };
    const rejected = coordination(
      github.cfg,
      port,
      "issue",
      github.identity("A"),
    );
    assert.throws(() => {
      if (operation === "acquire") {
        rejected.acquire();
      } else if (operation === "save") {
        rejected.save({ stage: "review" });
      } else {
        rejected.release();
      }
    }, HELD);
    const journal = path.join(
      paths.runDir(github.cfg, github.issue),
      "coordination-uncertain.json",
    );
    const intent = fs.readFileSync(journal, "utf8");
    assert.ok(intent.includes(operation));
    assert.ok(intent.includes("evidence"));
    assert.throws(() => rejected.acquire(), HELD);
    assert.throws(() => github.guard("B").request(), HELD);
    assert.equal(fs.readFileSync(journal, "utf8"), intent);
    assert.deepEqual(github.comments, before);
    assert.deepEqual(github.locks, refs);
  });
}

for (const invalid of ["missing ref", "changed ref"]) {
  test(`${invalid} rejects cached ownership without replacing durable evidence`, () => {
    const github = world();
    const a = github.guard();
    a.request();
    assert.equal(a.acquire(), true);
    a.assertOwner();
    const ref = refOf("issue", 0);
    if (invalid === "missing ref") {
      github.locks.clear();
    } else {
      github.locks.set(ref, "f".repeat(SHA_WIDTH));
    }
    const before = structuredClone(github.comments);
    const refs = new Map(github.locks);
    const writes = [...github.writes];
    assert.throws(() => a.assertOwner(), HELD);
    assert.throws(() => a.save({ stale: true }), HELD);
    assert.throws(() => a.release(), HELD);
    assert.deepEqual(github.comments, before);
    assert.deepEqual(github.locks, refs);
    assert.deepEqual(github.writes, writes);
  });
}

test("an unresolved confirmation retains exact intent and cannot grant local ownership or repeat the append", () => {
  const github = world();
  const a = github.guard();
  const b = github.guard("B");
  const aId = a.request();
  const bId = b.request();
  github.uncertain("confirm");
  assert.throws(() => a.acquire(), HELD);
  const before = structuredClone(github.comments);
  const writes = [...github.writes];
  assert.throws(() => a.assertOwner(), HELD);
  assert.throws(() => a.acquire(), HELD);
  const journal = path.join(
    paths.runDir(github.cfg, github.issue),
    "coordination-uncertain.json",
  );
  const retained = CONFIRM_INTENT.parse(
    JSON.parse(fs.readFileSync(journal, "utf8")),
  );
  assert.equal(retained.evidence, before.at(-1)?.body);
  // An independent complete reader sees at most A, never B, as confirmed owner.
  const observer = coordination(
    github.cfg,
    { ...github.port, comments: () => structuredClone(github.comments) },
    "issue",
    github.identity("B"),
  );
  assert.equal(observer.read().owner?.id, aId);
  assert.equal(observer.read().confirmed, true);
  assert.deepEqual(
    observer.read().pending.map((request) => request.id),
    [aId, bId],
  );
  assert.equal(observer.acquire(), false);
  assert.throws(() => observer.save({ stale: true }), HELD);
  assert.throws(() => observer.release(), HELD);
  assert.deepEqual(github.comments, before);
  assert.deepEqual(github.writes, writes);
});
