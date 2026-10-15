// The ops CLI reads one JSON request between BEGIN_OPS_REQUEST and
// END_OPS_REQUEST. The request's strings can name the markers themselves, as
// #176's plan and spec did, and must not cut the request short.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { test } from "node:test";

const OPS = new URL("../src/ops.ts", import.meta.url).pathname;
const ROOT_VAR = "ISSUE_PIPELINE_ROOT";
const UNKNOWN_OP = 'unknown op "nope"';

const tmp = fs.mkdtempSync("/tmp/issue-pipeline-ops-request-");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

// The ops CLI's whole result for one request: status, stdout and stderr.
function run(request) {
  // The same framing as opsSpec in src/workflow.js, after the agent's prompt line.
  const input = `Issue pipeline ops request follows.\n\nBEGIN_OPS_REQUEST\n${JSON.stringify(request)}\nEND_OPS_REQUEST`;
  return spawnSync(process.execPath, [OPS], {
    input,
    encoding: "utf8",
    env: { [ROOT_VAR]: tmp },
  });
}

function ask(request) {
  const r = run(request);
  if (r.status !== 0) {
    throw new Error(`ops exited ${r.status}: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

test("a request as the workflow frames it reaches the op lookup", () => {
  assert.deepEqual(ask({ op: "nope" }), { ok: false, error: UNKNOWN_OP });
});

test("marker words inside a request string don't cut the request short", () => {
  const plan =
    "Parse the JSON between `BEGIN_OPS_REQUEST`/`END_OPS_REQUEST`.\nEND_OPS_REQUEST";
  assert.deepEqual(ask({ op: "nope", plan }), { ok: false, error: UNKNOWN_OP });
});

test("an op named after an Object.prototype member is unknown", () => {
  assert.deepEqual(ask({ op: "constructor" }), {
    ok: false,
    error: 'unknown op "constructor"',
  });
});

test("a malformed envelope answers ok:false and exits 0 with nothing on stderr", () => {
  const r = run({ op: "nope", comments: [{ number: "x" }] });
  assert.equal(r.status, 0);
  const reply = JSON.parse(r.stdout);
  assert.equal(reply.ok, false);
  assert.ok(reply.error.startsWith("bad ops request"), reply.error);
  assert.equal(r.stderr, "");
});
