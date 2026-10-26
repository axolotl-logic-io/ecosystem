import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { POLICY_VERSION } from "../../src/standards/schema.ts";
import { committedPolicy } from "../project-policy-test-kit.ts";

const SOURCE = path.resolve(import.meta.dirname, "../..");
const ISSUE = 7;
const SHA256_WIDTH = 64;
const PRIVATE_FILE = 0o600;
const EXECUTABLE = 0o755;
const REFUSED = 2;
const CALLS = z.array(z.array(z.string()));
const HANDOFF = z.strictObject({
  issue: z.literal(ISSUE),
  branch: z.string(),
  version: z.literal(1),
  repo: z.literal("o/r"),
  source: z.string(),
  policy: z.literal(POLICY_VERSION),
  digest: z.string(),
  task: z.literal("implement"),
  next: z.string(),
});

function git(directory: string, args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

interface World {
  origin: string;
  head: string;
  apply: () => SpawnSyncReturns<string>;
  denyCollaborator: () => void;
  calls: () => string[][];
  cleanup: () => void;
}

function world(): World {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "standards-apply-"));
  const origin = path.join(directory, "origin");
  const bin = path.join(directory, "bin");
  const root = path.join(directory, "root");
  for (const folder of [origin, bin, root]) {
    fs.mkdirSync(folder);
  }
  git(origin, ["init", "--initial-branch=main"]);
  git(origin, ["config", "user.name", "Standards fixture"]);
  git(origin, ["config", "user.email", "standards@example.test"]);
  git(origin, ["commit", "--allow-empty", "-m", "Initial source"]);
  const head = git(origin, ["rev-parse", "HEAD"]);
  const fixture = path.join(directory, "world.json");
  const calls = path.join(directory, "calls.jsonl");
  const marker = {
    version: 1,
    repo: "o/r",
    source: head,
    policy: POLICY_VERSION,
    digest: `sha256:${"d".repeat(SHA256_WIDTH)}`,
  };
  const data = {
    issue: ISSUE,
    body: `Upgrade the project.\n<!-- standards-upgrade:plan ${JSON.stringify(marker)} -->`,
    collaboratorReadable: true,
  };
  fs.writeFileSync(fixture, JSON.stringify(data));
  fs.writeFileSync(calls, "");
  const fakeGh = path.join(import.meta.dirname, "fake-gh.ts");
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\nNODE_COMPILE_CACHE=${JSON.stringify(path.join(directory, "compile-cache"))} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGh)} "$@"\n`,
    { mode: EXECUTABLE },
  );
  const credentials = path.join(directory, "credentials.env");
  fs.writeFileSync(
    credentials,
    "ISSUE_PIPELINE_DEV_GITHUB_TOKEN=dev-token\nISSUE_PIPELINE_LANDING_GITHUB_TOKEN=landing-token\n",
    { mode: PRIVATE_FILE },
  );
  const config = path.join(directory, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo: "o/r",
      cloneUrl: origin,
      baseBranch: "main",
      devAccount: "dev-bot",
      landingAccount: "land-bot",
      allowedUsers: ["alice"],
      credentialsEnvFile: credentials,
      projectPolicy: committedPolicy(path.join(directory, "policy"), origin, {
        resources: { modelSessions: 1 },
        commands: { test: "true" },
      }),
    }),
  );
  const { PATH: searched = "" } = process.env;
  return {
    origin,
    head,
    apply: (): SpawnSyncReturns<string> =>
      spawnSync(
        process.execPath,
        [
          "scripts/standards-upgrade.ts",
          "apply",
          "--config",
          config,
          "--issue",
          String(ISSUE),
        ],
        {
          cwd: SOURCE,
          encoding: "utf8",
          env: {
            ...process.env,
            ...Object.fromEntries([
              ["PATH", `${bin}${path.delimiter}${searched}`],
              ["ISSUE_PIPELINE_ROOT", root],
              ["STANDARDS_WORLD", fixture],
              ["STANDARDS_CALLS", calls],
            ]),
          },
        },
      ),
    denyCollaborator: (): void => {
      fs.writeFileSync(
        fixture,
        JSON.stringify({ ...data, collaboratorReadable: false }),
      );
    },
    calls: (): string[][] =>
      CALLS.parse(
        fs
          .readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line: string): unknown => JSON.parse(line)),
      ),
    cleanup: (): void => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test("standards apply reports a separate human start request without writing or printing the retired launcher", () => {
  const sandbox = world();
  try {
    const result = sandbox.apply();
    assert.equal(result.status, 0, result.stderr);
    const handoff = HANDOFF.parse(JSON.parse(result.stdout));
    assert.equal(handoff.source, sandbox.head);
    assert.equal(handoff.branch, `agent/issue-${ISSUE}`);
    assert.ok(handoff.next.includes("start:implement"));
    assert.ok(handoff.next.includes("grants no execution permission"));
    assert.equal(result.stdout.includes("caller-jobs"), false);
    assert.equal(git(sandbox.origin, ["rev-parse", "main"]), sandbox.head);
    const calls = sandbox.calls();
    assert.ok(calls.length > 0);
    assert.ok(
      calls.every(
        (args) =>
          (args[0] === "api" || (args[0] === "issue" && args[1] === "list")) &&
          !args.some(
            (arg, index) =>
              ["-f", "-F", "--input", "--field", "--raw-field"].includes(arg) ||
              ((arg === "--method" || arg === "-X") &&
                args[index + 1] !== "GET"),
          ),
      ),
    );
  } finally {
    sandbox.cleanup();
  }
});

test("standards apply refuses a moved source without a handoff", () => {
  const sandbox = world();
  try {
    git(sandbox.origin, ["commit", "--allow-empty", "-m", "Move target"]);
    const result = sandbox.apply();
    assert.equal(result.status, REFUSED, result.stderr);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes("reassess and file a new plan"));
  } finally {
    sandbox.cleanup();
  }
});

test("standards apply holds unreadable collaborator evidence without a handoff", () => {
  const sandbox = world();
  try {
    sandbox.denyCollaborator();
    const result = sandbox.apply();
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes("collaborator"));
  } finally {
    sandbox.cleanup();
  }
});
