// The buddy runtime's trusted configuration through its real entrypoint,
// `src/buddy.ts`, as the operator runs it: `--check` over real files and a
// real pinned project policy, and a polling buddy stopped by SIGTERM.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { BUDDY_RUN } from "../../../src/runtime/observations.ts";
import {
  CHECKED,
  checkBuddy,
  digestOf,
  SOURCE,
  sandbox,
  writePrivate,
} from "../../support/runtime/buddy-test-kit.ts";

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
const SHARED = 0o664;

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

test("retired repository controls change nothing about a buddy's grant", () => {
  const box = sandbox(false);
  try {
    const file = box.buddy({});
    const before = digestOf(box, file);
    const retired = {
      assignments: { grantor: "former-grantor" },
      grant: { login: "former-grantor" },
      takeNewWork: false,
      skipLabels: ["deploy"],
      maxJobs: 1,
      stageCaps: { author: 1 },
      orchestratorIntervalSeconds: 1,
      maxCiFixes: 0,
      maxSyncs: 0,
      maxConflictFixes: 0,
    };
    const original = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(fs.readFileSync(box.repository, "utf8")));
    writePrivate(box.repository, { ...original, ...retired });
    const checked = checkBuddy(file, box.root);
    assert.equal(checked.status, 0, checked.stderr);
    const summary = CHECKED.parse(JSON.parse(checked.stdout));
    assert.deepEqual(summary.tasks, ["author", "implement", "harden", "sync"]);
    assert.equal(summary.repositories.at(0)?.authorization, before);
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

test("buddy --check refuses a repository that pins no committed project policy", () => {
  const box = sandbox(false);
  try {
    const { projectPolicy: _pinned, ...unpinned } = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(fs.readFileSync(box.repository, "utf8")));
    writePrivate(box.repository, {
      ...unpinned,
      commands: { test: "npm test" },
      resources: { modelSessions: 2 },
    });
    const refused = checkBuddy(box.buddy({}), box.root);
    assert.equal(refused.status, 1);
    assert.ok(
      refused.stderr.includes("must pin projectPolicy"),
      refused.stderr,
    );
  } finally {
    box.cleanup();
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
      observed.loops.map(({ task, state, polledAt, reason }) => ({
        task,
        state,
        polled: polledAt !== null,
        unreadable: (reason ?? "").includes("unreadable"),
      })),
      ["author", "implement", "harden", "sync"].map((task) => ({
        task,
        state: "held",
        polled: true,
        unreadable: true,
      })),
    );
  } finally {
    box.cleanup();
  }
});
