// @ts-check
// Issue #108: a failed native version probe refuses the session and says why,
// with the probe's exit and a redacted, bounded stderr excerpt, through the
// real job and a pi whose `--version` answers as each case scripts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { READER_STAGE, repliesAt } from "../job-fixtures.mjs";
import { logOf, piStarts, runJob, setUp } from "./job-test-kit.mjs";

const STAGE_ARGS = ["--stage", READER_STAGE, "--lane", "L"];
const WRONG_VERSION =
  "runtime: the native pi executable must report version 1.2.0";
const PREFIX = `the author's session failed: ${WRONG_VERSION}`;
// The job env's PIPELINE_MODEL_KEY, the fixture's declared credential.
const CREDENTIAL = "offline-fixture-credential";
const SHIM = "No version is set for shim: node";
// The refusal's excerpt limit, and stderr well past it.
const LIMIT = 300;
const LONG = "x".repeat(LIMIT * 10);

const CASES = [
  {
    name: "exit 1 with a credential and an escape sequence on stderr",
    probe: `printf '\\033[31mauth %s rejected\\033[0m\\n' "$PIPELINE_MODEL_KEY" >&2; exit 1`,
    reason: `${PREFIX}; the probe failed with exit status 1; stderr: auth [redacted] rejected`,
  },
  {
    name: "exit 127 with more stderr than the limit",
    probe: `printf '%s' '${LONG}' >&2; exit 127`,
    reason: `${PREFIX}; the probe failed with exit status 127; stderr (truncated to ${LIMIT} bytes): ${"x".repeat(LIMIT)}`,
  },
  {
    name: "a HOME-relative mise shim",
    probe: `echo '${SHIM}' >&2; exit 127`,
    reason: `${PREFIX}; the probe failed with exit status 127; stderr: ${SHIM}`,
  },
  {
    name: "exit 0 with the wrong version",
    probe: "echo 1.1.0; echo ignored >&2; exit 0",
    reason: PREFIX,
  },
];

// pi answers `--version` with `probe` and hands every other call to the
// kit's fake RPC pi.
/** @param {string} bin @param {string} probe @returns {void} */
function scriptProbe(bin, probe) {
  const rpc = path.join(bin, "pi-rpc");
  fs.renameSync(path.join(bin, "pi"), rpc);
  fs.writeFileSync(
    path.join(bin, "pi"),
    `#!/bin/sh\nif [ "$1" = --version ]; then\n${probe}\nfi\nexec '${rpc}' "$@"\n`,
    { mode: 0o755 },
  );
}

for (const { name, probe, reason } of CASES) {
  test(`a version probe with ${name} refuses the session and says why`, () => {
    const place = setUp(repliesAt(READER_STAGE), { events: [] });
    scriptProbe(place.bin, probe);
    const r = runJob(place, STAGE_ARGS);
    assert.equal(r.status, 0, r.stderr);
    const stop = logOf(place, "ops.log").find(({ op }) => op === "stop");
    assert.equal(stop?.code, "error");
    assert.equal(stop?.reason, reason);
    assert.ok(!JSON.stringify(stop).includes(CREDENTIAL));
    assert.deepEqual(piStarts(place), []);
  });
}
