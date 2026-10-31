import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { promisify } from "node:util";
import { z } from "zod";
import { PROGRAMS } from "../../programs.ts";

const INSTALLED = z.object({
  commit: z.string(),
  dirty: z.boolean(),
  files: z.array(z.string()),
  backup: z.string(),
});
const FLEET = z.object({
  installRoot: z.string(),
  buddies: z.array(z.unknown()),
});
const execute = promisify(execFile);
const SOURCE = path.resolve(import.meta.dirname, "../..");
const DEPENDENCIES = path.resolve(SOURCE, "node_modules");
const TEST_TIMEOUT_MS = 120_000;
const RETAINED_BYTES = Buffer.from("00ff01", "hex");
const SYMLINK_REFUSAL = /refusing symlink destination/u;

function command(
  cwd: string,
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    env,
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
      return !["dist", "node_modules", "test", ".git"].includes(first ?? "");
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
      path.resolve(sandbox.source, "tasks/gherkin/prompts/gherkin.md"),
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
          ["ECOSYSTEM_INSTALL_ROOT", root],
          ["PI_CODING_AGENT_DIR", agent],
        ]),
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      fs.readFileSync(path.join(root, "prompts/gherkin.md"), "utf8"),
      prompt,
    );
    const installed = INSTALLED.parse(
      JSON.parse(fs.readFileSync(path.join(root, "INSTALLED.json"), "utf8")),
    );
    assert.equal(installed.commit, commit);
    assert.equal(installed.dirty, true);
    assert.ok(result.stdout.includes("with uncommitted changes"));
    const config = path.join(sandbox.root, "buddy.json");
    const repository = path.join(sandbox.root, "repository.json");
    fs.writeFileSync(
      repository,
      JSON.stringify({ repo: "acme/widgets", baseBranch: "main" }),
    );
    fs.writeFileSync(
      config,
      JSON.stringify({
        version: 2,
        name: "operator",
        scope: { repositories: [repository] },
        tasks: ["gherkin", "implement", "fix", "verify", "land"],
        account: {
          login: "operator",
          credentials: {
            file: path.join(sandbox.root, "private-credentials"),
            variable: "TOKEN",
          },
        },
      }),
    );
    // The operator's service environment names the install root.
    const service = {
      ...process.env,
      ...Object.fromEntries([["ECOSYSTEM_INSTALL_ROOT", root]]),
    };
    const args = ["--config", config, "--check"];
    const launcher = command(
      sandbox.root,
      process.execPath,
      [path.join(root, "launcher.mjs"), ...args],
      service,
    );
    const fleet = path.join(sandbox.root, "fleet.json");
    fs.writeFileSync(
      fleet,
      JSON.stringify({
        version: 1,
        buddies: [config],
        launcher: path.join(root, "launcher.mjs"),
      }),
    );
    const orchestrator = command(
      sandbox.root,
      process.execPath,
      [path.join(root, "orchestrator.mjs"), "--config", fleet, "--check"],
      service,
    );
    const checkedFleet = FLEET.parse(JSON.parse(orchestrator));
    assert.equal(checkedFleet.buddies.length, 1);
    assert.equal(checkedFleet.installRoot, root);
    assert.ok(launcher.includes(path.join(root, "gherkin.mjs")));
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
    const operatorFile = path.join(root, "work.json");
    fs.writeFileSync(operatorFile, "do not change\n");
    const result = spawnSync(process.execPath, ["install.ts", "--dry-run"], {
      cwd: sandbox.source,
      encoding: "utf8",
      timeout: TEST_TIMEOUT_MS,
      env: {
        ...process.env,
        ...Object.fromEntries([
          ["ECOSYSTEM_INSTALL_ROOT", root],
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
    assert.equal(fs.readFileSync(operatorFile, "utf8"), "do not change\n");
    assert.equal(fs.existsSync(agent), false);
  } finally {
    sandbox.cleanup();
  }
});

test("replacement backs up every managed file and preserves private and operator bytes", () => {
  const sandbox = fixture();
  try {
    const root = path.join(sandbox.root, "operator-root");
    const agent = path.join(sandbox.root, "agent");
    const templates = path.join(agent, "agents/issue-pipeline");
    fs.mkdirSync(root);
    fs.mkdirSync(templates, { recursive: true });
    const previous = new Map([
      [path.join(root, "gherkin.mjs"), "old program\n"],
      [path.join(root, "README.md"), "previous identity\n"],
      [path.join(root, "INSTALLED.json"), '{"commit":"old"}\n'],
      [path.join(templates, "issue-pipeline-developer.md"), "old agent\n"],
    ]);
    for (const [file, text] of previous) {
      fs.writeFileSync(file, text);
    }
    const retained = path.join(root, "runs/acme__widgets/retained.bin");
    const privateConfig = path.join(root, "repos/private.json");
    const privateAgent = path.join(templates, "operator.md");
    for (const file of [retained, privateConfig, privateAgent]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, RETAINED_BYTES);
    }
    const result = spawnSync(process.execPath, ["install.ts"], {
      cwd: sandbox.source,
      encoding: "utf8",
      timeout: TEST_TIMEOUT_MS,
      env: {
        ...process.env,
        ...Object.fromEntries([
          ["ECOSYSTEM_INSTALL_ROOT", root],
          ["PI_CODING_AGENT_DIR", agent],
        ]),
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const installed = INSTALLED.parse(
      JSON.parse(fs.readFileSync(path.join(root, "INSTALLED.json"), "utf8")),
    );
    for (const [file, text] of previous) {
      assert.equal(
        fs.readFileSync(
          path.join(
            installed.backup,
            path.relative(path.parse(file).root, file),
          ),
          "utf8",
        ),
        text,
      );
      assert.ok(installed.files.includes(file));
    }
    for (const file of [retained, privateConfig, privateAgent]) {
      assert.deepEqual(fs.readFileSync(file), RETAINED_BYTES);
      assert.equal(installed.files.includes(file), false);
    }
    assert.equal(installed.dirty, false);
    assert.ok(
      fs
        .readFileSync(path.join(templates, "git-reviewer.md"), "utf8")
        .includes(path.join(root, "git-review.mjs")),
    );
    assert.equal(
      fs.readFileSync(path.join(root, "prompts/gherkin.md"), "utf8"),
      fs.readFileSync(
        path.join(sandbox.source, "tasks/gherkin/prompts/gherkin.md"),
        "utf8",
      ),
    );
  } finally {
    sandbox.cleanup();
  }
});

test("a symlink in the installation plan refuses before replacing any operator file", () => {
  const sandbox = fixture();
  try {
    const root = path.join(sandbox.root, "operator-root");
    const outside = path.join(sandbox.root, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "prompts"), "dir");
    const program = path.join(root, "fix.mjs");
    fs.writeFileSync(program, "previous release\n");
    const result = spawnSync(process.execPath, ["install.ts"], {
      cwd: sandbox.source,
      encoding: "utf8",
      timeout: TEST_TIMEOUT_MS,
      env: {
        ...process.env,
        ...Object.fromEntries([
          ["ECOSYSTEM_INSTALL_ROOT", root],
          ["PI_CODING_AGENT_DIR", path.join(sandbox.root, "agent")],
        ]),
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, SYMLINK_REFUSAL);
    assert.equal(fs.readFileSync(program, "utf8"), "previous release\n");
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.existsSync(path.join(root, "INSTALLED.json")), false);
  } finally {
    sandbox.cleanup();
  }
});

test("concurrent installs use private builds and leave source distribution output untouched", async () => {
  const sandbox = fixture();
  try {
    await Promise.all(
      ["first", "second"].map(async (name): Promise<void> => {
        const root = path.join(sandbox.root, name);
        await execute(process.execPath, ["install.ts"], {
          cwd: sandbox.source,
          timeout: TEST_TIMEOUT_MS,
          env: {
            ...process.env,
            ...Object.fromEntries([
              ["ECOSYSTEM_INSTALL_ROOT", root],
              ["PI_CODING_AGENT_DIR", path.join(sandbox.root, `${name}-agent`)],
            ]),
          },
        });
        command(root, process.execPath, [
          "--check",
          path.join(root, "launcher.mjs"),
        ]);
        const compiler = fs.globSync(
          "vendor/node_modules/typescript-*/lib/typescript.js",
          { cwd: root },
        );
        assert.equal(compiler.length, 1);
        assert.equal(
          fs.lstatSync(path.join(root, compiler[0] ?? "missing")).nlink,
          1,
        );
      }),
    );
    assert.equal(fs.existsSync(path.join(sandbox.source, "dist")), false);
  } finally {
    sandbox.cleanup();
  }
});
