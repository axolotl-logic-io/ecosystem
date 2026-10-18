// Which op errors count as network failures, which a stage defers on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isNetworkError } from "../src/workflow/stages/network.ts";

const NETWORK = [
  "git fetch exited 128: fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com",
  "gh exited 1: error connecting to api.github.com",
  "fatal: unable to access: Failed to connect to github.com port 443: Connection timed out",
  "fatal: unable to access: Recv failure: Connection reset by peer",
  "gh exited 1: HTTP 502: Bad Gateway",
  "gh exited 1: HTTP 503: Service Unavailable",
  "gh exited 1: HTTP 504: Gateway Timeout",
  "fatal: unable to access: The requested URL returned error: 503",
  // In any letter case (#385).
  "read tcp 10.0.0.5:51234->1.2.3.4:443: read: connection reset by peer",
  "fatal: unable to access: connection timed out",
];

const NOT_NETWORK = [
  "gh exited 1: HTTP 500: Internal Server Error",
  "exited 1: fatal: not a git repository",
  "",
  null,
];

test("network failures are network errors", () => {
  for (const text of NETWORK) {
    assert.equal(isNetworkError(text), true, text);
  }
});

test("other errors, and no error, are not", () => {
  for (const text of NOT_NETWORK) {
    assert.equal(isNetworkError(text), false, String(text));
  }
});
