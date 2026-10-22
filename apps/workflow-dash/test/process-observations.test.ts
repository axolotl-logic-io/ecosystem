import assert from "node:assert/strict";
import { test } from "node:test";
import { live } from "../process-observations.ts";

const fixturePid = 12;
test("process observations preserve denied and missing evidence as unknown", async () => {
  let checks = 0;
  function observed(): Promise<boolean> {
    checks += 1;
    return Promise.resolve(true);
  }
  assert.equal(await live({ outcome: null, pid: fixturePid }, observed), true);
  assert.equal(
    await live({ outcome: { kind: "finished" }, pid: fixturePid }, observed),
    false,
  );
  assert.equal(checks, 1);
  assert.equal(
    await live({ outcome: null, pid: fixturePid }, () =>
      Promise.resolve(false),
    ),
    false,
  );
  assert.equal(await live({ pid: fixturePid }, observed), null);
  assert.equal(
    await live({ outcome: null, pid: fixturePid }, () =>
      Promise.reject(Object.assign(new Error("denied"), { code: "EPERM" })),
    ),
    null,
  );
});
