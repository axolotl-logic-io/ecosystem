import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { RESOURCE_CAPACITY } from "../../src/project-policy-schema.ts";

const SOURCE = path.resolve(import.meta.dirname, "../..");
const OBSERVED = z.strictObject({
  digest: z.string(),
  resources: RESOURCE_CAPACITY,
});
const LOADER = `
import { loadConfig } from './src/config.ts';
import { configPolicyDigest } from './src/project-policy.ts';
const cfg = loadConfig(process.argv[1]);
console.log(JSON.stringify({digest: configPolicyDigest(cfg), resources: cfg.resources}));
`;

function git(directory: string, args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function fixture(): {
  cleanup: () => void;
  pin: (settings: object) => string;
  configure: (revision: string, extra?: object) => string;
  policyFile: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-policy-"));
  const origin = path.join(root, "origin.git");
  const repository = path.join(root, "policy");
  fs.mkdirSync(origin);
  fs.mkdirSync(repository);
  git(origin, ["init", "--bare", "--initial-branch=main"]);
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Policy test"]);
  git(repository, ["config", "user.email", "policy@example.test"]);
  git(repository, ["remote", "add", "origin", origin]);
  const policyFile = path.join(repository, ".issue-pipeline.json");
  return {
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    policyFile,
    pin: (settings: object): string => {
      fs.writeFileSync(policyFile, JSON.stringify(settings));
      git(repository, ["add", ".issue-pipeline.json"]);
      git(repository, ["commit", "--allow-empty", "-m", "Pin settings"]);
      return git(repository, ["rev-parse", "HEAD"]);
    },
    configure: (revision: string, extra: object = {}): string => {
      const example = z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(
            fs.readFileSync(path.join(SOURCE, "repos", "example.json"), "utf8"),
          ),
        );
      const file = path.join(root, "repo.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          ...example,
          repo: "owner/repo",
          cloneUrl: origin,
          projectPolicy: { repository, revision },
          ...extra,
        }),
      );
      return file;
    },
  };
}

function load(file: string): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", LOADER, file],
    { cwd: SOURCE, encoding: "utf8" },
  );
}

test("trusted capacity follows the immutable policy pin, not the working tree", () => {
  const sandbox = fixture();
  try {
    const first = sandbox.pin({
      commands: { test: "npm test" },
      resources: { modelSessions: 1 },
    });
    const initial = load(sandbox.configure(first));
    assert.equal(initial.status, 0, initial.stderr);
    const before = OBSERVED.parse(JSON.parse(initial.stdout));
    fs.writeFileSync(
      sandbox.policyFile,
      JSON.stringify({
        commands: { test: "npm test" },
        resources: { modelSessions: 9 },
      }),
    );
    const unchanged = load(sandbox.configure(first));
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.deepEqual(OBSERVED.parse(JSON.parse(unchanged.stdout)), before);
    const second = sandbox.pin({
      commands: { test: "npm test" },
      resources: { modelSessions: 2 },
    });
    const changed = load(sandbox.configure(second));
    assert.equal(changed.status, 0, changed.stderr);
    const after = OBSERVED.parse(JSON.parse(changed.stdout));
    assert.equal(before.resources.modelSessions, 1);
    assert.equal(after.resources.modelSessions, 2);
    assert.notEqual(after.digest, before.digest);
  } finally {
    sandbox.cleanup();
  }
});

test("committed policy rejects an operator capacity override", () => {
  const sandbox = fixture();
  try {
    const revision = sandbox.pin({
      commands: { test: "npm test" },
      resources: { modelSessions: 1 },
    });
    const result = load(
      sandbox.configure(revision, { resources: { modelSessions: 99 } }),
    );
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("resources must not also appear"));
    assert.equal(result.stdout, "");
  } finally {
    sandbox.cleanup();
  }
});

test("missing or invalid committed capacity has no default or flat fallback", () => {
  const sandbox = fixture();
  try {
    for (const resources of [undefined, { modelSessions: 0 }]) {
      const revision = sandbox.pin({
        commands: { test: "npm test" },
        resources,
      });
      const result = load(sandbox.configure(revision));
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes("resources"));
      assert.equal(result.stdout, "");
    }
  } finally {
    sandbox.cleanup();
  }
});

test("repository Land permission changes the shared policy without changing capacity", () => {
  const sandbox = fixture();
  try {
    const revision = sandbox.pin({
      commands: { test: "npm test" },
      resources: { modelSessions: 1 },
    });
    const denied = load(
      sandbox.configure(revision, { permissions: { land: false } }),
    );
    const allowed = load(
      sandbox.configure(revision, { permissions: { land: true } }),
    );
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(allowed.status, 0, allowed.stderr);
    const before = OBSERVED.parse(JSON.parse(denied.stdout));
    const after = OBSERVED.parse(JSON.parse(allowed.stdout));
    assert.notEqual(before.digest, after.digest);
    assert.deepEqual(before.resources, after.resources);
  } finally {
    sandbox.cleanup();
  }
});
