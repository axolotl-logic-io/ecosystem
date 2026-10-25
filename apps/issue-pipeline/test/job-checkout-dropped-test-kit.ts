// A real isolated code checkout and binary-safe dirty work for recovery tests.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Config } from "../src/config.ts";
import type { DroppedChanges } from "../src/job/checkout-close.ts";
import type { RecoveryOrigin } from "../src/job/dropped-patch.ts";
import {
  configIn,
  git,
  ISSUE,
  root,
  write,
} from "./pipeline-commit-test-kit.ts";

const { paths }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const { closeJobCheckout }: typeof import("../src/job/checkout-close.ts") =
  await import("../src/job/checkout-close.ts");
const { openJobCheckout }: typeof import("../src/job/checkout.ts") =
  await import("../src/job/checkout.ts");
const { tearDown }: typeof import("../src/job/teardown.ts") = await import(
  "../src/job/teardown.ts"
);
const { openStatus }: typeof import("../src/job/status.ts") = await import(
  "../src/job/status.ts"
);

const KEY = "implement-1";
const EXECUTABLE_MODE = 0o755;
const REGULAR_EXECUTABLE_MODE = 0o10_0755;
// Git writes an executable it checks out as 0777 less the process umask. The
// umask's bits all lie within 0777, so subtracting it clears exactly those.
const REGULAR_FULL_MODE = 0o10_0777;
const CHECKED_OUT_EXECUTABLE_MODE: number = REGULAR_FULL_MODE - process.umask();
const COMMIT_ENV = Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]);
const BINARY = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));
const LATIN1 = Buffer.from("café\n", "latin1");
const LEFT = ["new.txt", "notes.txt", "blob.bin", "latin1.txt", "run.sh"];

interface Opened {
  cfg: Config;
  root: string;
  repo: string;
  branch: string;
  origin: string;
}

function openIn(cfg: Config, tmp: string): Opened {
  const job = { stage: "implement", branch: `agent/issue-${ISSUE}` };
  const dirs = openJobCheckout(cfg, ISSUE, job);
  return {
    cfg,
    root: dirs.root,
    repo: dirs.repo,
    branch: dirs.branch,
    origin: path.join(tmp, "origin.git"),
  };
}

// Returns a fresh implement job's checkouts for #7
function openFresh(): Opened {
  const tmp = fs.mkdtempSync(path.join(root, "dropped-"));
  return openIn(configIn(tmp), tmp);
}

async function close(
  job: Opened,
  key: string,
  recovery: RecoveryOrigin = {
    stage: "implement",
    outcome: "stop",
    reason: null,
  },
): Promise<DroppedChanges> {
  const { cfg, repo, branch } = job;
  const dirs = { root: job.root, repo, branch, key };
  return await closeJobCheckout(cfg, ISSUE, { ...dirs, recovery }, null);
}

async function timedOutReview(job: Opened, key: string): Promise<void> {
  const status = openStatus(paths.runDir(job.cfg, ISSUE), {
    id: key,
    issue: ISSUE,
    stage: "review",
    lane: "L",
    startedAt: "2026-10-19T19:11:00.000Z",
    socket: "/unused",
    prompts: [],
  });
  return await tearDown(
    job.cfg,
    {
      issue: ISSUE,
      stage: "review",
      key,
      dirs: job,
      push: null,
      status,
      runOp: async () => ({ ok: true, reply: {} }),
      // This job still owns the issue.
      owner: () => undefined,
    },
    {
      kind: "finished",
      summary: {
        issue: ISSUE,
        stage: "review",
        end: "stop",
        reason: "the hardening session failed: timed out before it exited",
      },
    },
  );
}

// Leaves every kind of uncommitted change in `dir`, whose tracked file is
// `tracked`, and an ignored file; returns each changed file's bytes.
function leaveChanges(dir: string, tracked: string): Map<string, Buffer> {
  write(dir, tracked, "staged\n");
  git(dir, ["add", tracked]);
  write(dir, tracked, "staged\nunstaged\n");
  write(dir, "new.txt", "staged new\n");
  git(dir, ["add", "new.txt"]);
  write(dir, "notes.txt", "untracked\n");
  fs.writeFileSync(path.join(dir, "blob.bin"), BINARY);
  fs.writeFileSync(path.join(dir, "latin1.txt"), LATIN1);
  write(dir, "run.sh", "#!/bin/sh\nprintf executable\n");
  fs.chmodSync(path.join(dir, "run.sh"), EXECUTABLE_MODE);
  const exclude = git(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  fs.appendFileSync(exclude, "ignored.txt\n");
  write(dir, "ignored.txt", "ignored\n");
  const files = new Map();
  for (const file of [tracked, ...LEFT]) {
    files.set(file, fs.readFileSync(path.join(dir, file)));
  }
  return files;
}

// A fresh clone of `origin` at `sha` with `patch` applied by
// `git apply --index`.
function restored(origin: string, sha: string, patch: string): string {
  const fresh = fs.mkdtempSync(path.join(root, "fresh-"));
  execFileSync("git", ["clone", "--quiet", origin, fresh]);
  git(fresh, ["checkout", "--quiet", sha]);
  git(fresh, ["apply", "--index", patch]);
  return fresh;
}

function inRunDir(cfg: Config, relative: string): string {
  return path.join(paths.runDir(cfg, ISSUE), relative);
}

function under(prefix: string, files: Map<string, Buffer>): string[] {
  return [...files.keys()].map((file) => `${prefix}/${file}`);
}

export type { Opened };
export {
  CHECKED_OUT_EXECUTABLE_MODE,
  COMMIT_ENV,
  close,
  inRunDir,
  KEY,
  leaveChanges,
  openFresh,
  openIn,
  REGULAR_EXECUTABLE_MODE,
  restored,
  timedOutReview,
  under,
};
