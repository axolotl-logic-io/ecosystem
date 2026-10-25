// Buddy-run and action-run observation files for tests, written as the buddy
// runtime writes them: one whole `run.json` per run under the runs folder.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import type {
  ActionRunObservation,
  BuddyRunObservation,
} from "../runtime-run-schema.ts";

const leaseSeconds = 60;
const millisecondsPerSecond = 1000;
const commitLength = 40;
const digestLength = 64;
const commit = "a".repeat(commitLength);
const digest = "b".repeat(digestLength);
const repo = "fixture-org/fixture-repo";
const slug = "fixture-org__fixture-repo";

function buddyRun(
  id: string,
  overrides: Partial<BuddyRunObservation> = {},
): BuddyRunObservation {
  const now = Date.now();
  return {
    kind: "buddy-run",
    version: 1,
    id,
    previous: null,
    buddy: {
      name: "fixture-buddy",
      role: "developer",
      identity: "fixture-identity",
      config: "/fixture/buddy.json",
    },
    tasks: ["implement"],
    scope: {
      organization: "fixture-org",
      repositories: [
        {
          config: "/fixture/repo.json",
          repo,
          base: "main",
          authorization: digest,
        },
      ],
    },
    accounts: [{ provider: "github", login: "fixture-login" }],
    process: {
      pid: process.pid,
      host: hostname(),
      startedAt: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
    },
    lease: {
      seconds: leaseSeconds,
      expiresAt: new Date(
        now + leaseSeconds * millisecondsPerSecond,
      ).toISOString(),
    },
    state: "running",
    outcome: null,
    stop: null,
    loops: [
      {
        task: "implement",
        repo,
        state: "idle",
        reason: null,
        polledAt: null,
        action: null,
      },
    ],
    caps: [{ repo, modelSessions: 2, testSlots: null }],
    ...overrides,
  };
}

function actionRun(
  id: string,
  buddyRunId: string,
  issue: number,
  overrides: Partial<ActionRunObservation> = {},
): ActionRunObservation {
  const workItem = { repo, number: issue };
  return {
    kind: "action-run",
    version: 1,
    id,
    previous: null,
    buddyRun: buddyRunId,
    task: "implement",
    workItem,
    binding: {
      workItem,
      task: "implement",
      target: { branch: "main", commit },
      requirements: `sha256:${digest}`,
    },
    cause: { signal: "ready", recordId: 1 },
    execution: {
      instance: id,
      lane: "implement",
      issue,
      branch: `issue-${issue}`,
      repo,
      base: "main",
    },
    mode: "act",
    authorization: digest,
    state: "running",
    outcome: null,
    verdict: null,
    reason: null,
    stop: null,
    checkpoint: { state: "none", at: null, reason: null },
    ownership: { state: "held", reason: null },
    sessions: [],
    operations: [],
    reservations: [],
    preserved: { checkout: null, patches: [] },
    ...overrides,
  };
}

function buddyRunPath(runs: string, id: string): string {
  return join(runs, "buddy-runs", id, "run.json");
}
function actionRunPath(runs: string, issue: number, id: string): string {
  return join(runs, slug, `issue-${issue}`, "actions", id, "run.json");
}
async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function writeObservation(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value));
}

/** A real Node process whose main script is `folder/script`. */
async function nodeProcess(
  folder: string,
  script: string,
): Promise<ChildProcess & { pid: number }> {
  const path = join(folder, script);
  await writeText(path, "setInterval(() => undefined, 1000);\n");
  const child = spawn(process.execPath, [path], { stdio: "ignore" });
  await once(child, "spawn");
  const { pid } = child;
  if (pid === undefined) {
    throw new Error("fixture process has no pid");
  }
  return Object.assign(child, { pid });
}

export {
  actionRun,
  actionRunPath,
  buddyRun,
  buddyRunPath,
  leaseSeconds,
  nodeProcess,
  repo,
  slug,
  writeObservation,
  writeText,
};
