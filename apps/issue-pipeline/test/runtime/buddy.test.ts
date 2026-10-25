// The buddy runtime's trusted configuration through its real entrypoints:
// `src/buddy.ts --check` as the operator runs it, and
// `bindBuddyAuthorization` as an ops child calls it, each in a fresh
// process over real files and a real pinned project policy.

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { BUDDY_RUN } from "../../src/runtime/observations.ts";

const SOURCE = path.resolve(import.meta.dirname, "../..");
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const CHECKED = z.strictObject({
  buddy: z.string(),
  role: z.string(),
  identity: z.string(),
  tasks: z.array(z.string()),
  repositories: z.array(
    z.strictObject({
      config: z.string(),
      repo: z.string(),
      base: z.string(),
      modelSessions: z.int(),
      authorization: SHA256,
    }),
  ),
});
const BOUND = z.strictObject({
  authorization: z.strictObject({
    config: z.string(),
    repository: z.string(),
    run: z.string(),
    task: z.string(),
    digest: SHA256,
  }),
  policyUnchanged: z.boolean(),
});
// An ops child's binding: loads the repository config, binds it to the
// envelope and reports the internal authorization and whether the shared
// checking policy was left alone.
const BINDER = `
import { loadConfig } from './src/config.ts';
import { bindBuddyAuthorization } from './src/runtime/buddy-config.ts';
const [file, envelope] = process.argv.slice(1);
const cfg = loadConfig(file);
const bound = bindBuddyAuthorization(cfg, file, JSON.parse(envelope));
console.log(JSON.stringify({
  authorization: bound.buddyAuthorization,
  policyUnchanged: JSON.stringify(bound.policyBinding) === JSON.stringify(cfg.policyBinding),
}));
`;
const ENDED = z.strictObject({
  buddyRun: z.uuid(),
  kind: z.enum(["stopped", "failed"]),
  reason: z.string(),
});
// A gh that stops the buddy calling it, then fails: the stop arrives in the
// middle of a poll, which finishes its reads (each failure a hold) before
// the run stops.
const STOPPING_GH = "#!/bin/sh\nkill -TERM $PPID\nexit 1\n";
const EXECUTABLE = 0o755;
const RUN = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const PRIVATE = 0o600;
const SHARED = 0o664;

function git(directory: string, args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function writePrivate(file: string, value: object): void {
  fs.writeFileSync(file, JSON.stringify(value));
  fs.chmodSync(file, PRIVATE);
}

interface Sandbox {
  root: string;
  repository: string;
  cleanup: () => void;
  buddy: (settings: object) => string;
}

// A pinned project policy with a shared pool of two model sessions and a
// trusted repository config that pins it, with `land` as its Land
// permission.
function sandbox(land: boolean): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-buddy-"));
  const origin = path.join(root, "origin.git");
  const policy = path.join(root, "policy");
  fs.mkdirSync(origin);
  fs.mkdirSync(policy);
  git(origin, ["init", "--bare", "--initial-branch=main"]);
  git(policy, ["init", "--initial-branch=main"]);
  git(policy, ["remote", "add", "origin", origin]);
  git(policy, ["config", "user.name", "Buddy test"]);
  git(policy, ["config", "user.email", "buddy@example.test"]);
  fs.writeFileSync(
    path.join(policy, ".issue-pipeline.json"),
    JSON.stringify({
      commands: { test: "npm test" },
      resources: { modelSessions: 2 },
    }),
  );
  git(policy, ["add", ".issue-pipeline.json"]);
  git(policy, ["commit", "-m", "Pin settings"]);
  const example = z
    .record(z.string(), z.unknown())
    .parse(
      JSON.parse(
        fs.readFileSync(
          path.join(SOURCE, "repos", "committed-settings.example.json"),
          "utf8",
        ),
      ),
    );
  const repository = path.join(root, "repo.json");
  const credentials = path.join(root, "credentials.env");
  fs.writeFileSync(
    credentials,
    "ISSUE_PIPELINE_DEV_GITHUB_TOKEN=dev-token\nISSUE_PIPELINE_LANDING_GITHUB_TOKEN=landing-token\n",
  );
  fs.chmodSync(credentials, PRIVATE);
  writePrivate(repository, {
    ...example,
    credentialsEnvFile: credentials,
    repo: "owner/repo",
    cloneUrl: origin,
    permissions: { land },
    projectPolicy: {
      repository: policy,
      revision: git(policy, ["rev-parse", "HEAD"]),
    },
  });
  return {
    root,
    repository,
    cleanup: (): void => {
      fs.rmSync(root, { recursive: true, force: true });
    },
    buddy: (settings: object): string => {
      const file = path.join(root, "buddy.json");
      writePrivate(file, {
        version: 1,
        name: "hippy",
        scope: { organization: "owner", repositories: [repository] },
        role: "developer",
        identity: {
          name: "hippy",
          account: { provider: "github", login: "DEVELOPMENT-BOT" },
          profiles: ["writer"],
        },
        ...settings,
      });
      return file;
    },
  };
}

const GATEKEEPER = {
  name: "lawd",
  role: "gatekeeper",
  identity: {
    name: "lawd",
    account: { provider: "github", login: "REVIEW-MERGE-BOT" },
    profiles: ["reader", "lander"],
  },
};

function run(args: string[], root: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, {
    cwd: SOURCE,
    encoding: "utf8",
    env: {
      ...process.env,
      ...Object.fromEntries([
        ["ISSUE_PIPELINE_ROOT", path.join(root, "pipeline")],
      ]),
    },
  });
}

function checkBuddy(file: string, root: string): SpawnSyncReturns<string> {
  return run(["src/buddy.ts", "--config", file, "--check"], root);
}

function bind(box: Sandbox, envelope: object): SpawnSyncReturns<string> {
  return run(
    [
      "--input-type=module",
      "--eval",
      BINDER,
      box.repository,
      JSON.stringify(envelope),
    ],
    box.root,
  );
}

// The authorization digest buddy --check reports for `file`'s only
// repository; throws when the check refuses.
function digestOf(box: Sandbox, file: string): string {
  const checked = checkBuddy(file, box.root);
  if (checked.status !== 0) {
    throw new Error(checked.stderr);
  }
  const [repository] = CHECKED.parse(JSON.parse(checked.stdout)).repositories;
  if (repository === undefined) {
    throw new Error("buddy --check reported no repository");
  }
  return repository.authorization;
}

interface Envelope {
  config: string;
  run: string;
  task: string;
  authorizationDigest: string;
}

function landEnvelope(box: Sandbox, file: string): Envelope {
  return {
    config: file,
    run: RUN,
    task: "land",
    authorizationDigest: digestOf(box, file),
  };
}

test("buddy --check validates a Developer against its repository's pinned pool", () => {
  const box = sandbox(false);
  try {
    const checked = checkBuddy(box.buddy({}), box.root);
    assert.equal(checked.status, 0, checked.stderr);
    const summary = CHECKED.parse(JSON.parse(checked.stdout));
    assert.deepEqual(summary.tasks, ["author", "implement", "harden", "sync"]);
    assert.deepEqual(
      summary.repositories.map(({ repo, modelSessions }) => ({
        repo,
        modelSessions,
      })),
      [{ repo: "owner/repo", modelSessions: 2 }],
    );
  } finally {
    box.cleanup();
  }
});

test("buddy --check refuses obsolete controls, foreign accounts and untrusted files", () => {
  const box = sandbox(false);
  try {
    const obsolete = checkBuddy(box.buddy({ maxJobs: 3 }), box.root);
    assert.equal(obsolete.status, 1);
    assert.ok(obsolete.stderr.includes("maxJobs"), obsolete.stderr);
    const capped = checkBuddy(box.buddy({ modelSessions: 9 }), box.root);
    assert.equal(capped.status, 1);
    assert.ok(capped.stderr.includes("resources.modelSessions"), capped.stderr);
    const foreign = checkBuddy(
      box.buddy({
        identity: {
          name: "hippy",
          account: { provider: "github", login: "REVIEW-MERGE-BOT" },
          profiles: ["writer"],
        },
      }),
      box.root,
    );
    assert.equal(foreign.status, 1);
    assert.ok(foreign.stderr.includes("account"), foreign.stderr);
    const landing = checkBuddy(
      box.buddy({ permissions: { land: true } }),
      box.root,
    );
    assert.equal(landing.status, 1);
    assert.ok(landing.stderr.includes("permissions.land"), landing.stderr);
    const shared = box.buddy({});
    fs.chmodSync(shared, SHARED);
    const untrusted = checkBuddy(shared, box.root);
    assert.equal(untrusted.status, 1);
    assert.ok(
      untrusted.stderr.includes("writable by no one else"),
      untrusted.stderr,
    );
  } finally {
    box.cleanup();
  }
});

test("buddy --check refuses a repository with no trusted model-session capacity", () => {
  const box = sandbox(false);
  try {
    const { resources: _resources, ...legacy } = z
      .record(z.string(), z.unknown())
      .parse(
        JSON.parse(
          fs.readFileSync(path.join(SOURCE, "repos", "example.json"), "utf8"),
        ),
      );
    writePrivate(box.repository, {
      ...legacy,
      repo: "owner/repo",
      devAccount: "DEVELOPMENT-BOT",
      landingAccount: "REVIEW-MERGE-BOT",
      credentialsEnvFile: path.join(box.root, "credentials.env"),
    });
    const refused = checkBuddy(box.buddy({}), box.root);
    assert.equal(refused.status, 1);
    assert.ok(
      refused.stderr.includes("no valid resources.modelSessions capacity"),
      refused.stderr,
    );
  } finally {
    box.cleanup();
  }
});

test("bindBuddyAuthorization binds the action's digest without touching the shared policy", () => {
  const box = sandbox(false);
  try {
    const file = box.buddy({});
    const digest = digestOf(box, file);
    const envelope = {
      config: file,
      run: RUN,
      task: "implement",
      authorizationDigest: digest,
    };
    const bound = bind(box, envelope);
    assert.equal(bound.status, 0, bound.stderr);
    const result = BOUND.parse(JSON.parse(bound.stdout));
    assert.equal(result.policyUnchanged, true);
    assert.deepEqual(result.authorization, {
      config: file,
      repository: box.repository,
      run: RUN,
      task: "implement",
      digest,
    });
    const foreignTask = bind(box, { ...envelope, task: "land" });
    assert.notEqual(foreignTask.status, 0);
    assert.ok(
      foreignTask.stderr.includes("responsibilities"),
      foreignTask.stderr,
    );
    box.buddy({ pollSeconds: 120 });
    const changed = bind(box, envelope);
    assert.notEqual(changed.status, 0);
    assert.ok(
      changed.stderr.includes("changed since the action began"),
      changed.stderr,
    );
  } finally {
    box.cleanup();
  }
});

test("Land binds only when both the buddy and the repository grant it", () => {
  const refused = sandbox(false);
  const granted = sandbox(true);
  try {
    const permitted = { ...GATEKEEPER, permissions: { land: true } };
    const repositoryRefuses = bind(
      refused,
      landEnvelope(refused, refused.buddy(permitted)),
    );
    assert.notEqual(repositoryRefuses.status, 0);
    assert.ok(
      repositoryRefuses.stderr.includes(
        "owner/repo's config grants no Land permission",
      ),
      repositoryRefuses.stderr,
    );
    const bothGrant = bind(
      granted,
      landEnvelope(granted, granted.buddy(permitted)),
    );
    assert.equal(bothGrant.status, 0, bothGrant.stderr);
    const buddyRefuses = bind(
      granted,
      landEnvelope(granted, granted.buddy(GATEKEEPER)),
    );
    assert.notEqual(buddyRefuses.status, 0);
    assert.ok(
      buddyRefuses.stderr.includes(
        "the buddy config grants no Land permission",
      ),
      buddyRefuses.stderr,
    );
  } finally {
    refused.cleanup();
    granted.cleanup();
  }
});

test("SIGTERM stops a polling buddy cooperatively and records the canonical run", () => {
  const box = sandbox(false);
  try {
    const bin = path.join(box.root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "gh"), STOPPING_GH);
    fs.chmodSync(path.join(bin, "gh"), EXECUTABLE);
    const pipeline = path.join(box.root, "pipeline");
    const { PATH: searchPath } = process.env;
    const result = spawnSync(
      process.execPath,
      ["src/buddy.ts", "--config", box.buddy({})],
      {
        cwd: SOURCE,
        encoding: "utf8",
        env: {
          ...process.env,
          ...Object.fromEntries([
            ["ISSUE_PIPELINE_ROOT", pipeline],
            ["PATH", `${bin}${path.delimiter}${searchPath ?? ""}`],
          ]),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const ended = ENDED.parse(JSON.parse(result.stdout));
    assert.equal(ended.kind, "stopped");
    assert.equal(ended.reason, "SIGTERM received");
    const observed = BUDDY_RUN.parse(
      JSON.parse(
        fs.readFileSync(
          path.join(pipeline, "runs", "buddy-runs", ended.buddyRun, "run.json"),
          "utf8",
        ),
      ),
    );
    assert.equal(observed.state, "stopped");
    assert.equal(observed.stop?.scope, "buddy");
    assert.deepEqual(observed.caps, [
      { repo: "owner/repo", modelSessions: 2, testSlots: null },
    ]);
    assert.deepEqual(
      observed.loops.map(({ task, state, polledAt }) => ({
        task,
        state,
        polled: polledAt !== null,
      })),
      ["author", "implement", "harden", "sync"].map((task) => ({
        task,
        state: "stopped",
        polled: true,
      })),
    );
  } finally {
    box.cleanup();
  }
});
