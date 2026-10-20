// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";
import { coordination } from "../src/coordination.ts";
import { assertReconciled, confirmedWrite } from "../src/execution.ts";
import { instanceId, world } from "./coordination-test-kit.mjs";

/** @import { CoordinationPort } from "../src/coordination.ts" */
const UNCERTAIN = /uncertain/u;
const HELD = /reconciliation|uncertain/u;
/** @param {ReturnType<typeof world>} github @param {string} lane @param {number} omitted */
function contender(github, lane, omitted) {
  const cfg = { ...github.cfg, slug: `${github.cfg.slug}-machine-b` };
  /** @type {CoordinationPort} */
  const port = {
    ...github.port,
    comments: () => {
      assertReconciled(cfg, github.issue);
      return structuredClone(
        github.comments.filter((row) => row.id !== omitted),
      );
    },
    write: (operation, write, confirmed, evidence) =>
      confirmedWrite(cfg, github.issue, operation, {
        write,
        confirmed,
        evidence: evidence ?? null,
      }),
  };
  return {
    cfg,
    port,
    guard: coordination(cfg, port, "scope", github.identity("B", lane)),
  };
}
/** @param {ReturnType<typeof world>} github @param {() => void} acquire @returns {CoordinationPort} */
function beforeAcquire(github, acquire) {
  return {
    ...github.port,
    write: (operation, write, confirmed, evidence) => {
      if (operation === "acquire") {
        acquire();
      }
      github.port.write(operation, write, confirmed, evidence);
    },
  };
}
for (const lane of ["same", "different"]) {
  test(`atomic acquisition fences interleaved ${lane} lanes with incomplete initial listings`, () => {
    const github = world();
    const first = github.guard("A", "scope", "same");
    const aRequest = first.request();
    const second = github.guard("B", "scope", lane);
    const bRequest = second.request();
    const {
      cfg: cfgB,
      port: portB,
      guard: b,
    } = contender(github, lane, aRequest);
    let bWon = false;
    const portA = beforeAcquire(github, () => {
      bWon = b.acquire();
    });
    const a = coordination(
      github.cfg,
      portA,
      "scope",
      github.identity("A", "same"),
    );
    assert.throws(() => a.acquire(), UNCERTAIN);
    assert.equal(bWon, true);
    // The complete listing still confirms B; A's older request cannot use
    // comment order to override the single immutable acquisition result.
    portB.comments = () => structuredClone(github.comments);
    b.assertOwner();
    assert.equal(b.read().owner?.identity.instance, instanceId("B"));
    assert.throws(() => a.assertOwner(), UNCERTAIN);
    assert.throws(() => a.save({ heartbeat: "late" }), UNCERTAIN);
    assert.equal(github.locks.size, 1);
    assert.equal(b.read().confirmed, true);
    assert.deepEqual(
      b.read().pending.map((request) => request.id),
      [aRequest, bRequest],
    );
    // A clean observer also refuses A, independently of A's uncertain journal.
    const loser = coordination(
      cfgB,
      portB,
      "scope",
      github.identity("A", "same"),
    );
    const before = structuredClone(github.comments);
    const refs = new Map(github.locks);
    assert.throws(() => loser.assertOwner(), HELD);
    assert.throws(() => loser.save({ stale: true }), HELD);
    assert.throws(() => loser.release(), HELD);
    assert.deepEqual(github.comments, before);
    assert.deepEqual(github.locks, refs);
    b.assertOwner();
  });
}

for (const lane of ["same", "different"]) {
  test(`an omitted confirmed owner holds the ${lane} lane contender without touching order or refs`, () => {
    const github = world();
    const a = github.guard("A", "scope", "same");
    a.request();
    assert.equal(a.acquire(), true);
    const b = github.guard("B", "scope", lane);
    const bRequest = b.request();
    const partial = coordination(
      github.cfg,
      {
        ...github.port,
        comments: () =>
          structuredClone(github.comments.filter((row) => row.id === bRequest)),
      },
      "scope",
      github.identity("B", lane),
    );
    const before = structuredClone(github.comments);
    const refs = new Map(github.locks);
    const writes = [...github.writes];
    assert.throws(() => partial.acquire(), HELD);
    assert.throws(() => partial.save({ stage: "review" }), HELD);
    assert.throws(() => partial.release(), HELD);
    assert.deepEqual(github.comments, before);
    assert.deepEqual(github.locks, refs);
    assert.deepEqual(github.writes, writes);
    assert.equal(b.acquire(), false);
    a.assertOwner();
  });
}
