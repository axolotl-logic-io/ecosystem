// @ts-check
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { githubRead, transientGithubRead } = await import(
  "../src/github-read.ts"
);
const TRANSIENT = [
  "error connecting to api.github.com",
  "i/o timeout",
  "net/http: request canceled (Client.Timeout exceeded while awaiting headers)",
  "context deadline exceeded",
  "unexpected EOF",
  "HTTP 502",
  "HTTP 503",
  "secondary rate limit",
];
for (const stderr of TRANSIENT) {
  test(`GitHub read retries ${stderr} without a wall-clock wait`, () => {
    assert.equal(
      transientGithubRead({ code: 1, timedOut: false, stdout: "", stderr }),
      true,
    );
    /** @type {number[]} */
    const waits = [];
    mock.method(
      Atomics,
      "wait",
      /** @type {typeof Atomics.wait} */ (
        (_array, _index, _value, ms) => {
          waits.push(ms ?? 0);
          return "timed-out";
        }
      ),
    );
    try {
      let attempts = 0;
      const read = githubRead(() => {
        attempts += 1;
        if (attempts === 1) {
          return { code: 1, timedOut: false, stdout: "", stderr };
        }
        return { code: 0, timedOut: false, stdout: "ok", stderr: "" };
      });
      assert.equal(read.attempts, 2);
      assert.equal(read.result.stdout, "ok");
      assert.equal(waits.length, 1);
      assert.ok((waits[0] ?? 0) > 0);
    } finally {
      mock.restoreAll();
    }
  });
}
