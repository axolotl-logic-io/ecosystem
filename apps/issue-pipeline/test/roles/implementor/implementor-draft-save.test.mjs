// @ts-check
// The Developer must checkpoint the PR before any writer, never just at end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeContext, PR } from "../implementor-test-kit.mjs";

const { implementorRole } = await import(
  "../../../src/roles/implementor/implementor.ts"
);

test("the writer observes durable PR state; a failed PR save launches no writer", async () => {
  const good = fakeContext();
  const runSession = good.ctx.session;
  good.ctx.session = async (spec) => {
    assert.equal(good.saves.length, 1);
    assert.equal(good.saves[0]?.pr, PR);
    return await runSession(spec);
  };
  assert.equal((await implementorRole(good.ctx)).kind, "next");
  const bad = fakeContext();
  bad.ctx.save = () => Promise.reject(new Error("save failed"));
  await assert.rejects(implementorRole(bad.ctx), { message: "save failed" });
  assert.equal(bad.sessions.length, 0);
});
