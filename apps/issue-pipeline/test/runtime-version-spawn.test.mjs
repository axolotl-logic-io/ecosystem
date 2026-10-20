// @ts-check
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";

const { probeVersion } = await import("../src/job/runtime-version.ts");
const REQUIRED = /native pi executable must report version 1\.2\.0/u;
const NO_STATUS = /no normal exit status was available/u;
const SECRET = /synthetic-model-secret/u;

for (const systemCode of ["EACCES", undefined]) {
  test(`a synchronous spawn failure reports only its safe code ${systemCode ?? "unknown"}`, ({
    mock,
  }) => {
    /** @type {NodeJS.ErrnoException} */
    const error = new Error("synthetic-model-secret raw attached error");
    error.code = systemCode;
    mock.method(childProcess, "spawnSync", () => {
      throw error;
    });
    syncBuiltinESMExports();
    try {
      const refusal = probeVersion("/", {}, {}, []);
      assert.match(refusal ?? "", REQUIRED);
      assert.match(refusal ?? "", NO_STATUS);
      assert.ok(
        refusal?.includes(`spawn/probe error ${systemCode ?? "unknown"}`),
      );
      assert.ok(refusal?.includes("stderr was empty"));
      assert.ok(!refusal?.includes("raw attached error"));
      assert.doesNotMatch(refusal ?? "", SECRET);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

test("a probe timeout cannot be ignored by the shim", ({ mock }) => {
  // Check the OS boundary deterministically: a real SIGTERM-ignoring child
  // would block spawnSync (and the test runner) if this guarantee regressed.
  let calls = 0;
  mock.method(
    childProcess,
    "spawnSync",
    /** @param {string} _file @param {string[]} _args @param {import("node:child_process").SpawnSyncOptions} options @returns {import("node:child_process").SpawnSyncReturns<string>} */ (
      _file,
      _args,
      options,
    ) => {
      calls += 1;
      assert.ok((options.timeout ?? 0) > 0);
      assert.equal(options.killSignal, "SIGKILL");
      /** @type {NodeJS.ErrnoException} */
      const error = new Error("unreportable raw timeout error");
      error.code = "ETIMEDOUT";
      return {
        pid: 1,
        output: [null, "", "No version is set for shim: node"],
        stdout: "",
        stderr: "No version is set for shim: node",
        status: null,
        signal: "SIGKILL",
        error,
      };
    },
  );
  syncBuiltinESMExports();
  try {
    const refusal = probeVersion("/", {}, {}, []);
    assert.match(refusal ?? "", NO_STATUS);
    assert.ok(refusal?.includes("timed out (ETIMEDOUT)"));
    assert.ok(refusal?.includes("termination signal SIGKILL"));
    assert.ok(refusal?.includes("No version is set for shim: node"));
    assert.ok(!refusal?.includes("unreportable raw timeout error"));
    assert.equal(calls, 1);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});
