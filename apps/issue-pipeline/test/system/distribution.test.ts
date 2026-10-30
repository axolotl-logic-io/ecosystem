import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { PROGRAMS } from "../../programs.ts";

const SOURCE = path.resolve(import.meta.dirname, "../..");
const DEPENDENCIES = path.resolve(SOURCE, "..", "..", "node_modules");
const TEST_TIMEOUT_MS = 120_000;

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
  const source = path.join(root, "source/apps/issue-pipeline");
  fs.cpSync(SOURCE, source, {
    recursive: true,
    filter: (file: string): boolean => {
      const [first] = path.relative(SOURCE, file).split(path.sep);
      return !["dist", "node_modules", "test"].includes(first ?? "");
    },
  });
  fs.cpSync(
    path.resolve(SOURCE, "../../tasks"),
    path.resolve(source, "../../tasks"),
    { recursive: true },
  );
  fs.cpSync(
    path.resolve(SOURCE, "../launcher"),
    path.resolve(source, "../launcher"),
    { recursive: true },
  );
  fs.symlinkSync(DEPENDENCIES, path.join(source, "node_modules"), "dir");
  command(path.resolve(source, "../.."), "git", [
    "init",
    "--initial-branch=main",
  ]);
  command(source, "git", ["config", "user.name", "Distribution test"]);
  command(source, "git", ["config", "user.email", "distribution@example.test"]);
  command(source, "git", ["add", "../.."]);
  command(source, "git", ["commit", "-m", "Fixture source"]);
  return {
    root,
    source,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("build writes every program and leaves other output files alone", () => {
  const sandbox = fixture();
  try {
    const output = path.join(sandbox.root, "output");
    fs.mkdirSync(output);
    const evidence = path.join(output, "receipt.json");
    fs.writeFileSync(evidence, "preserved bytes\n");
    command(sandbox.source, process.execPath, ["build.ts", output]);
    for (const { file } of PROGRAMS) {
      command(sandbox.source, process.execPath, [
        "--check",
        path.join(output, file),
      ]);
    }
    assert.equal(fs.readFileSync(evidence, "utf8"), "preserved bytes\n");
    assert.ok(fs.existsSync(path.join(output, "standards-python-tools.txt")));
  } finally {
    sandbox.cleanup();
  }
});

test("installer accepts uncommitted source and records its dirty identity", () => {
  const sandbox = fixture();
  try {
    const root = path.join(sandbox.root, "operator-root");
    const agent = path.join(sandbox.root, "agent");
    const prompt = "# Modified local prompt\n";
    fs.writeFileSync(
      path.resolve(sandbox.source, "../../tasks/gherkin/prompts/gherkin.md"),
      prompt,
    );
    const commit = command(sandbox.source, "git", ["rev-parse", "HEAD"]).trim();
    const result = spawnSync(process.execPath, ["install.ts"], {
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
    assert.equal(
      fs.readFileSync(path.join(root, "prompts/gherkin.md"), "utf8"),
      prompt,
    );
    const installed = JSON.parse(
      fs.readFileSync(path.join(root, "INSTALLED.json"), "utf8"),
    );
    assert.equal(installed.commit, commit);
    assert.equal(installed.dirty, true);
    assert.ok(result.stdout.includes("with uncommitted changes"));
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
    const historical = path.join(root, "work.json");
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
    assert.ok(result.stdout.includes("standards-python-tools.txt"));
    assert.ok(result.stdout.includes("vendor/node_modules/typescript-"));
    assert.equal(fs.readFileSync(historical, "utf8"), "do not change\n");
    assert.equal(fs.existsSync(agent), false);
  } finally {
    sandbox.cleanup();
  }
});
