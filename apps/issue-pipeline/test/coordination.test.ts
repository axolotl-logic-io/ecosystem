import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.ts";
import { world } from "./coordination-test-kit.ts";

function prepare(
  guard: ReturnType<ReturnType<typeof world>["guard"]>,
  operation: string,
): boolean {
  if (operation === "acquire") {
    return true;
  }
  return guard.acquire();
}
function operate(
  guard: ReturnType<ReturnType<typeof world>["guard"]>,
  operation: string,
): boolean {
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
