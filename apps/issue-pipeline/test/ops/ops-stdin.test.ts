// The ops CLI reads its whole request even when fd 0 is a non-blocking pipe
// and the request arrives late and in pieces (#263). Reading such a pipe with
// a synchronous read answered "EAGAIN: resource temporarily unavailable".
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import process from "node:process";
import type { Readable } from "node:stream";
import { test } from "node:test";
import { endsWithTest } from "../bounded-test-kit.ts";

const OPS: string = new URL("../../src/ops.ts", import.meta.url).pathname;
const KIT: string = new URL("./nonblocking-stdin-test-kit.ts", import.meta.url)
  .pathname;
const READY = "nonblocking-stdin-ready\n";
const tmp = fs.mkdtempSync("/tmp/issue-pipeline-ops-stdin-");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
// Environment variables are named by strings, as src/process.ts takes them.
const env = Object.fromEntries([["ISSUE_PIPELINE_ROOT", tmp]]);

// Resolves once `stream` has carried `line`, and keeps draining it after.
function lineOn(stream: Readable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = "";
    stream.on("data", (chunk) => {
      seen += String(chunk);
      if (seen.includes(line)) {
        resolve();
      }
    });
    stream.on("end", () => {
      reject(new Error(`stderr ended without the ready line: ${seen}`));
    });
  });
}

test("a request that arrives late, in two chunks, on a non-blocking stdin reaches the op lookup", async () => {
  const child = spawn(process.execPath, ["--import", KIT, OPS], {
    stdio: "pipe",
    env,
  });
  endsWithTest(() => child.kill("SIGKILL"));
  const writeErrors: unknown[] = [];
  child.stdin.on("error", (error) => writeErrors.push(error));
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  const exited = once(child, "close");
  await lineOn(child.stderr, READY);
  const request = `Issue pipeline ops request follows.\n\nBEGIN_OPS_REQUEST\n${JSON.stringify({ op: "nope" })}\nEND_OPS_REQUEST`;
  const half = Math.floor(request.length / 2);
  const firstChunkRead = lineOn(child.stderr, "stdin-chunk-read\n");
  child.stdin.write(request.slice(0, half));
  await firstChunkRead;
  child.stdin.end(request.slice(half));
  const [code] = await exited;
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), {
    ok: false,
    error: 'unknown op "nope"',
  });
  assert.deepEqual(writeErrors, []);
});
