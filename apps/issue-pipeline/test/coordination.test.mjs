// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";
import { world } from "./coordination-test-kit.mjs";

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
  }
}
