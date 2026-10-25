import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { PROGRAMS, RETIRED_PROGRAMS } from "../programs.ts";

const SOURCE = path.resolve(import.meta.dirname, "..");
const DEPENDENCIES = path.resolve(SOURCE, "..", "..", "node_modules");
const TEST_TIMEOUT_MS = 120_000;
const OPS_REFUSAL = z.object({ ok: z.literal(false), error: z.string() });
const RETIRED_GRANT = /assignment grants are retired/u;

function command(cwd: string, program: string, args: string[]): string {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${program} failed: ${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function fixture(): { root: string; source: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-distribution-"));
  const source = path.join(root, "source");
  fs.cpSync(SOURCE, source, {
    recursive: true,
    filter: (file: string): boolean => {
      const [first] = path.relative(SOURCE, file).split(path.sep);
      return !["dist", "node_modules", "test"].includes(first ?? "");
    },
  });
  fs.symlinkSync(DEPENDENCIES, path.join(source, "node_modules"), "dir");
  command(source, "git", ["init", "--initial-branch=main"]);
  command(source, "git", ["config", "user.name", "Distribution test"]);
  command(source, "git", ["config", "user.email", "distribution@example.test"]);
  command(source, "git", ["add", "."]);
  command(source, "git", ["commit", "-m", "Fixture source"]);
  return {
    root,
    source,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("build retires old delivery executables without deleting historical evidence", () => {
  const sandbox = fixture();
  try {
    const output = path.join(sandbox.root, "output");
    fs.mkdirSync(output);
    for (const file of RETIRED_PROGRAMS) {
      fs.writeFileSync(path.join(output, file), "obsolete executable");
    }
    const evidence = path.join(output, "historical-receipt.json");
    fs.writeFileSync(evidence, "preserved bytes\n");
    command(sandbox.source, process.execPath, ["build.ts", output]);
    for (const { file } of PROGRAMS) {
      command(sandbox.source, process.execPath, [
        "--check",
        path.join(output, file),
      ]);
    }
    for (const file of RETIRED_PROGRAMS) {
      assert.equal(fs.existsSync(path.join(output, file)), false, file);
    }
    assert.equal(fs.readFileSync(evidence, "utf8"), "preserved bytes\n");
    assert.ok(fs.existsSync(path.join(output, "standards-python-tools.txt")));
  } finally {
    sandbox.cleanup();
  }
});

test("built ops refuses a retired assignment grant before loading configuration", () => {
  const sandbox = fixture();
  try {
    const output = path.join(sandbox.root, "output");
    const runtime = path.join(sandbox.root, "operator-root");
    command(sandbox.source, process.execPath, ["build.ts", output]);
    const request = JSON.stringify({
      op: "post",
      config: path.join(sandbox.root, "missing-config.json"),
      grant: { login: "former-grantor" },
    });
    const result = spawnSync(process.execPath, [path.join(output, "ops.mjs")], {
      cwd: sandbox.source,
      encoding: "utf8",
      input: `BEGIN_OPS_REQUEST\n${request}\nEND_OPS_REQUEST`,
      timeout: TEST_TIMEOUT_MS,
      env: {
        ...process.env,
        ...Object.fromEntries([["ISSUE_PIPELINE_ROOT", runtime]]),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const reply = OPS_REFUSAL.parse(JSON.parse(result.stdout));
    assert.match(reply.error, RETIRED_GRANT);
    assert.equal(fs.existsSync(runtime), false);
  } finally {
    sandbox.cleanup();
  }
});

test("installer dry run plans the buddy distribution and preserves operator files", () => {
  const sandbox = fixture();
  try {
    const root = path.join(sandbox.root, "operator-root");
    const agent = path.join(sandbox.root, "agent");
    fs.mkdirSync(root);
    for (const file of RETIRED_PROGRAMS) {
      fs.writeFileSync(path.join(root, file), `old ${file}\n`);
    }
    const historical = path.join(root, "historical-work.json");
    fs.writeFileSync(historical, "do not change\n");
    const result = spawnSync(process.execPath, ["install.ts", "--dry-run"], {
      cwd: sandbox.source,
      encoding: "utf8",
      timeout: TEST_TIMEOUT_MS,
      env: {
        ...process.env,
        ...Object.fromEntries([
          ["ISSUE_PIPELINE_ROOT", root],
          ["PI_CODING_AGENT_DIR", agent],
        ]),
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    for (const { file } of PROGRAMS) {
      assert.ok(result.stdout.includes(path.join(root, file)), file);
      assert.equal(fs.existsSync(path.join(root, file)), false, file);
    }
    for (const file of RETIRED_PROGRAMS) {
      assert.ok(
        result.stdout.includes(`retired  ${path.join(root, file)}`),
        file,
      );
      assert.equal(
        fs.readFileSync(path.join(root, file), "utf8"),
        `old ${file}\n`,
      );
    }
    assert.ok(result.stdout.includes("standards-python-tools.txt"));
    assert.ok(result.stdout.includes("vendor/node_modules/typescript-"));
    assert.equal(fs.readFileSync(historical, "utf8"), "do not change\n");
    assert.equal(fs.existsSync(agent), false);
  } finally {
    sandbox.cleanup();
  }
});
