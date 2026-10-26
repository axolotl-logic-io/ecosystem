import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { committedPolicy } from "../support/project-policy-test-kit.ts";

// What Land's effect stands on, against a real local origin: the exact
// remote target read, the R-contains-T check, the trusted Land grant, and
// the one guarded fast-forward that never overwrites a moved target.

const SOURCE = path.resolve(import.meta.dirname, "../..");
const ROOT_VARIABLE = "ISSUE_PIPELINE_ROOT";
const SHA_LENGTH = 40;
const ABSENT = "3".repeat(SHA_LENGTH);
const NOT_FETCHED = /is not in the fetched branches/u;
const NOT_ANCESTOR = /strict ancestor old target/u;
const DRIVER = `
import { loadConfig } from './src/config.ts';
import { landBranch } from './src/ops/land-branch.ts';
import { landGranted } from './src/tasks/permissions.ts';
import { exactRemote, fetchCommits, isAncestor } from './src/tasks/view.ts';
const [file, clone, action, base, head] = process.argv.slice(1);
const cfg = loadConfig(file);
const target = () => {
  try {
    return exactRemote(cfg, clone, 'refs/heads/main');
  } catch (error) {
    return 'unreadable: ' + error.message;
  }
};
let reply;
try {
  if (action === 'observe') {
    fetchCommits(cfg, clone, ['main', 'agent/issue-7'], [base, head]);
    reply = {
      target: target(),
      contains: isAncestor(clone, base, head),
      granted: landGranted(cfg),
    };
  } else if (action === 'fetch') {
    fetchCommits(cfg, clone, ['main'], [head]);
    reply = { fetched: true };
  } else {
    reply = { pushed: landBranch(cfg, clone, base, head), target: target() };
  }
} catch (error) {
  reply = { error: error.message, target: target() };
}
console.log(JSON.stringify(reply));
`;
const REPLY = z.looseObject({
  target: z.string().nullable().optional(),
  contains: z.boolean().optional(),
  granted: z.boolean().optional(),
  pushed: z.boolean().optional(),
  fetched: z.boolean().optional(),
  error: z.string().optional(),
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

function commit(repository: string, message: string): string {
  git(repository, ["commit", "--allow-empty", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]);
}

interface Sandbox {
  root: string;
  pipelineRoot: string;
  clone: string;
  work: string;
  config: (extra?: object) => string;
  cleanup: () => void;
}

function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-land-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const clone = path.join(root, "clone");
  const pipelineRoot = path.join(root, "pipeline");
  fs.mkdirSync(pipelineRoot);
  git(root, ["init", "--bare", "--initial-branch=main", origin]);
  git(root, ["clone", origin, work]);
  git(work, ["config", "user.name", "Land test"]);
  git(work, ["config", "user.email", "land@example.test"]);
  git(work, ["checkout", "-b", "main"]);
  commit(work, "Target");
  git(work, ["push", "origin", "main"]);
  git(root, ["clone", origin, clone]);
  const projectPolicy = committedPolicy(path.join(root, "policy"), origin, {
    commands: { test: "true" },
    resources: { modelSessions: 1 },
  });
  const example = z
    .record(z.string(), z.unknown())
    .parse(
      JSON.parse(
        fs.readFileSync(path.join(SOURCE, "repos", "example.json"), "utf8"),
      ),
    );
  return {
    root,
    pipelineRoot,
    clone,
    work,
    config: (extra: object = {}): string => {
      const file = path.join(root, "repo.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          ...example,
          repo: "owner/repo",
          cloneUrl: origin,
          projectPolicy,
          ...extra,
        }),
      );
      return file;
    },
    cleanup: (): void => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function drive(
  box: Sandbox,
  file: string,
  args: string[],
): z.infer<typeof REPLY> {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", DRIVER, file, box.clone, ...args],
    {
      cwd: SOURCE,
      encoding: "utf8",
      env: { ...process.env, [ROOT_VARIABLE]: box.pipelineRoot },
    },
  );
  if (run.status !== 0) {
    throw new Error(run.stderr);
  }
  return REPLY.parse(JSON.parse(run.stdout));
}

// The target T on main and revision R on the item's branch, one commit on.
function revision(box: Sandbox): { t: string; r: string } {
  const t = git(box.work, ["rev-parse", "HEAD"]);
  git(box.work, ["checkout", "-b", "agent/issue-7"]);
  const r = commit(box.work, "Revision");
  git(box.work, ["push", "origin", "agent/issue-7"]);
  git(box.work, ["checkout", "main"]);
  return { t, r };
}

test("Land reads the exact target, R containing T, and only a literal true grant", () => {
  const box = sandbox();
  try {
    const { t, r } = revision(box);
    const denied = drive(box, box.config(), ["observe", t, r]);
    assert.deepEqual(denied, { target: t, contains: true, granted: false });
    const granted = drive(box, box.config({ permissions: { land: true } }), [
      "observe",
      t,
      r,
    ]);
    assert.equal(granted.granted, true);
    const missing = drive(box, box.config(), ["fetch", t, ABSENT]);
    assert.match(missing.error ?? "", NOT_FETCHED);
  } finally {
    box.cleanup();
  }
});

test("Land fast-forwards the read target to R exactly once", () => {
  const box = sandbox();
  try {
    const { t, r } = revision(box);
    const file = box.config({ permissions: { land: true } });
    drive(box, file, ["observe", t, r]);
    const landed = drive(box, file, ["land", t, r]);
    assert.deepEqual(landed, { pushed: true, target: r });
  } finally {
    box.cleanup();
  }
});

test("Land never overwrites a target that moved after it was read", () => {
  const box = sandbox();
  try {
    const { t, r } = revision(box);
    const file = box.config({ permissions: { land: true } });
    drive(box, file, ["observe", t, r]);
    const moved = commit(box.work, "Someone else landed");
    git(box.work, ["push", "origin", "main"]);
    const refused = drive(box, file, ["land", t, r]);
    assert.equal(refused.pushed, false);
    assert.equal(refused.target, moved);
    const diverged = drive(box, file, ["observe", moved, r]);
    assert.deepEqual(diverged, {
      target: moved,
      contains: false,
      granted: true,
    });
    const sideways = drive(box, file, ["land", moved, r]);
    assert.match(sideways.error ?? "", NOT_ANCESTOR);
    assert.equal(sideways.target, moved);
  } finally {
    box.cleanup();
  }
});
