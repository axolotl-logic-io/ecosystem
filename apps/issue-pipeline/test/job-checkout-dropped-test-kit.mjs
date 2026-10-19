// @ts-check
// Real isolated code/wiki checkouts and binary-safe dirty work for recovery tests.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  configIn,
  git,
  ISSUE,
  root,
  write,
} from "./pipeline-commit-test-kit.mjs";

const { paths } = await import("../src/config.ts");
const { closeJobCheckout } = await import("../src/job/checkout-close.ts");
const { openJobCheckout } = await import("../src/job/checkout.ts");
const { tearDown } = await import("../src/job/teardown.ts");
const { openStatus } = await import("../src/job/status.ts");
/** @import { Config } from "../src/config.ts" */
const KEY = "implement-1";
const EXECUTABLE_MODE = 0o755;
const REGULAR_EXECUTABLE_MODE = 0o10_0755;
const COMMIT_ENV = Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]);
const BINARY = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));
const LATIN1 = Buffer.from("café\n", "latin1");
const LEFT = ["new.txt", "notes.txt", "blob.bin", "latin1.txt", "run.sh"];

/** @typedef {{ cfg: Config, root: string, repo: string, docs: string, branch: string, origin: string, wikiOrigin: string }} Opened */

/** @param {Config} cfg @param {string} tmp @returns {Opened} */
function openIn(cfg, tmp) {
  const job = { stage: "implement", branch: `agent/issue-${ISSUE}` };
  const dirs = openJobCheckout(cfg, ISSUE, job);
  if (dirs.docs === null) {
    throw new Error("the job has no wiki checkout");
  }
  return {
    cfg,
    root: dirs.root,
    repo: dirs.repo,
    docs: dirs.docs,
    branch: dirs.branch,
    origin: path.join(tmp, "origin.git"),
    wikiOrigin: path.join(tmp, "wiki-origin.git"),
  };
}

/** @returns {Opened} a fresh implement job's checkouts for #7 */
function openFresh() {
  const tmp = fs.mkdtempSync(path.join(root, "dropped-"));
  return openIn(configIn(tmp), tmp);
}

/** @param {Opened} job @param {string} key @param {import("../src/job/dropped-patch.ts").RecoveryOrigin} [recovery] */
async function close(
  job,
  key,
  recovery = { stage: "implement", outcome: "stop", reason: null },
) {
  const { cfg, repo, docs, branch } = job;
  const dirs = { root: job.root, repo, docs, branch, key };
  return await closeJobCheckout(
    cfg,
    ISSUE,
    { ...dirs, wiki: "write", recovery },
    null,
  );
}

/** @param {Opened} job @param {string} key */
async function timedOutReview(job, key) {
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
      wiki: "write",
      push: null,
      status,
      runOp: async () => ({ ok: true, reply: {} }),
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

/**
 * Leaves every kind of uncommitted change in `dir`, whose tracked file is
 * `tracked`, and an ignored file; returns each changed file's bytes.
 * @param {string} dir
 * @param {string} tracked
 * @returns {Map<string, Buffer>}
 */
function leaveChanges(dir, tracked) {
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

/**
 * A fresh clone of `origin` at `sha` with `patch` applied by
 * `git apply --index`.
 * @param {string} origin
 * @param {string} sha
 * @param {string} patch
 * @returns {string}
 */
function restored(origin, sha, patch) {
  const fresh = fs.mkdtempSync(path.join(root, "fresh-"));
  execFileSync("git", ["clone", "--quiet", origin, fresh]);
  git(fresh, ["checkout", "--quiet", sha]);
  git(fresh, ["apply", "--index", patch]);
  return fresh;
}

/** @param {Config} cfg @param {string} relative @returns {string} */
function inRunDir(cfg, relative) {
  return path.join(paths.runDir(cfg, ISSUE), relative);
}

/** @param {string} prefix @param {Map<string, Buffer>} files @returns {string[]} */
function under(prefix, files) {
  return [...files.keys()].map((file) => `${prefix}/${file}`);
}

export {
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
