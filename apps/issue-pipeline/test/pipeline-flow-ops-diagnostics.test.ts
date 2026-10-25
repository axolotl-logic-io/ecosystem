// A non-exit failure must name the signal instead of reporting only null.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { isolatedRoot } from "./isolated-root-test-kit.ts";

const RUN_MS = 20_000;
const SIGNALED = /real ops exited null \(signal SIGTERM, error none\)/u;

test("the flow observer distinguishes a signaled ops child from a numeric exit", () => {
  const kit = new URL("./pipeline-flow-ops-test-kit.ts", import.meta.url)
    .pathname;
  const wrapper = path.join(isolatedRoot, "ops.mjs");
  fs.writeFileSync(
    wrapper,
    `import { runFlowOps } from ${JSON.stringify(kit)};\nawait runFlowOps(${JSON.stringify(isolatedRoot)});\n`,
  );
  fs.writeFileSync(
    path.join(isolatedRoot, "real-ops.mjs"),
    'process.kill(process.pid, "SIGTERM");\n',
  );
  const result = spawnSync(process.execPath, [wrapper], {
    encoding: "utf8",
    input: 'BEGIN_OPS_REQUEST\n{"op":"stop"}\nEND_OPS_REQUEST',
    timeout: RUN_MS,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, SIGNALED);
  assert.equal(
    fs.existsSync(path.join(isolatedRoot, "ops-trace.jsonl")),
    false,
  );
});
