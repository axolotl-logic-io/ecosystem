// The buddy configuration tests' kit: a sandbox with a pinned project
// policy, a trusted repository config that pins it and buddy files written
// beside it, and `src/buddy.ts --check` run in a fresh process as the
// operator runs it.
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { committedPolicy } from "../project-policy-test-kit.ts";

const SOURCE = path.resolve(import.meta.dirname, "../../..");
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
// What `buddy --check` prints for a buddy it accepts.
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
const PRIVATE = 0o600;

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
  fs.mkdirSync(origin);
  git(origin, ["init", "--bare", "--initial-branch=main"]);
  const projectPolicy = committedPolicy(path.join(root, "policy"), origin, {
    commands: { test: "npm test" },
    resources: { modelSessions: 2 },
  });
  const example = z
    .record(z.string(), z.unknown())
    .parse(
      JSON.parse(
        fs.readFileSync(path.join(SOURCE, "repos", "example.json"), "utf8"),
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
    projectPolicy,
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

// Runs node with `args` in this source, its pipeline root under `root`.
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

export type { Sandbox };
export {
  CHECKED,
  checkBuddy,
  digestOf,
  run,
  SHA256,
  SOURCE,
  sandbox,
  writePrivate,
};
