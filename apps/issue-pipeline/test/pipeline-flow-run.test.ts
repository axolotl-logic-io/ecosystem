// Fixture runtime regression: no real GitHub, model, configured checks or load.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { setUpFlow } from "./pipeline-flow-test-kit.ts";

test("full-flow fakes use the current Node runtime without invoking an ambient shim", () => {
  const flow = setUpFlow();
  const ambient = path.join(flow.tmp, "ambient");
  const marker = path.join(flow.tmp, "shim-called");
  fs.mkdirSync(ambient);
  fs.writeFileSync(
    path.join(ambient, "node"),
    `#!/bin/sh\n: > '${marker}'\nexit 91\n`,
    { mode: 0o755 },
  );
  const bin = path.join(flow.tmp, "bin");
  const result = spawnSync("/usr/bin/env", ["node", "-p", "process.execPath"], {
    cwd: flow.home,
    env: {
      ...flow.env,
      ...Object.fromEntries([["PATH", `${bin}${path.delimiter}${ambient}`]]),
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.realpathSync(result.stdout.trim()),
    fs.realpathSync(process.execPath),
  );
  assert.equal(fs.existsSync(marker), false);
});
