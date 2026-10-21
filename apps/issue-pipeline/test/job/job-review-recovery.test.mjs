// @ts-check
// The next caller-owned Review job supplies recovery automatically, even with
// changed heads; the files are inert, readable data.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { outputEnd } from "../fake-rpc-pi.mjs";
import {
  claimWon,
  GHERKIN_COMMENT,
  GHERKIN_INPUTS,
  HEAD_SHA,
  repliesAt,
  stateAt,
} from "../job-fixtures.mjs";
import {
  flagValue,
  logOf,
  piStarts,
  runJob,
  setScript,
  setUp,
} from "./job-test-kit.mjs";

const KEY = "review-20261019T191100000Z";
const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROMPT =
  "# Hardening policy\n\nFor hardening and check-fix: run only targeted tests relevant to your changes. Do not run the configured full-check command inside the session. Deterministic verification runs it after the session. Inspect and incorporate useful preserved edits only within current scope.\n";

/** @param {import("./job-test-kit.mjs").Place} at */
function seedRecovery(at) {
  const dropped = path.join(at.runDir, "dropped");
  fs.mkdirSync(dropped, { recursive: true });
  const file = `${KEY}-repo.patch.index.patch`;
  const patch = path.join(dropped, file);
  const bytes = `Dropped changes of issue #7, job ${KEY}, checkout repo/\nBase: ${BASE}\nSnapshot: index\n\n`;
  fs.writeFileSync(patch, bytes);
  fs.writeFileSync(
    path.join(dropped, `${KEY}.json`),
    JSON.stringify({
      version: 1,
      repo: "o/r",
      issue: 7,
      branch: "agent/issue-7",
      job: KEY,
      origin: {
        stage: "review",
        outcome: "stop",
        reason: "the hardening session failed: timed out before it exited",
      },
      snapshots: [
        {
          file,
          checkout: "repo",
          source: "/old/job/repo",
          kind: "index",
          base: BASE,
        },
      ],
    }),
  );
  return { patch, bytes };
}

function reviewReplies() {
  const state = stateAt("review");
  return {
    ...repliesAt("review"),
    claim: claimWon(state, [GHERKIN_COMMENT]),
    "current-revision": {
      ok: true,
      revision: {
        code: HEAD_SHA,
        wiki: BASE,
        inputs: GHERKIN_INPUTS,
      },
      baseSha: HEAD_SHA,
      pr: null,
    },
  };
}

test("a fresh hardening writer gets previous timeout provenance and readable patches without an issue-comment handoff", () => {
  const at = setUp(
    reviewReplies(),
    {
      events: [
        outputEnd({ outcome: "cannot", reason: "Need a product answer" }),
      ],
    },
    { commands: { test: "mise //apps/issue-pipeline:check" } },
  );
  fs.writeFileSync(path.join(at.prompts, "hardening.md"), PROMPT);
  const { patch, bytes } = seedRecovery(at);
  const r = runJob(at, ["--stage", "review"]);
  assert.equal(r.status, 0, r.stderr);
  const [start] = piStarts(at);
  assert.equal(flagValue(start.argv, "--append-system-prompt"), PROMPT);
  const prompt = logOf(at, "pi.log").find(
    ({ command }) => command?.type === "prompt",
  );
  const task = prompt.command.message;
  assert.ok(task.includes('commands.test: "mise //apps/issue-pipeline:check"'));
  assert.ok(task.includes(KEY));
  assert.ok(task.includes("timed out before it exited"));
  assert.ok(task.includes(patch));
  assert.ok(task.includes("snapshot: index"));
  assert.ok(task.includes(BASE));
  assert.ok(task.includes("/old/job/repo"));
  assert.equal(fs.readFileSync(patch, "utf8"), bytes);
  assert.ok(
    !logOf(at, "ops.log").some(({ op }) => ["verify", "ready-pr"].includes(op)),
  );
});

/** @param {import("./job-test-kit.mjs").Place} at */
function savedEvidence(at) {
  const dropped = path.join(at.runDir, "dropped");
  const files = fs.readdirSync(dropped);
  const patchName = files.find((file) => file.endsWith("-repo.patch"));
  const manifestName = files.find((file) => file.endsWith(".json"));
  if (patchName === undefined || manifestName === undefined) {
    throw new Error("Review teardown did not save a patch and its manifest");
  }
  const patch = path.join(dropped, patchName);
  const manifest = path.join(dropped, manifestName);
  return {
    dropped,
    patch,
    manifest,
    patchBytes: fs.readFileSync(patch),
    manifestBytes: fs.readFileSync(manifest),
  };
}

/** @param {import("./job-test-kit.mjs").Place} at @returns {string} */
function latestTask(at) {
  return (
    logOf(at, "pi.log")
      .filter(({ command }) => command?.type === "prompt")
      .at(-1)?.command.message ?? ""
  );
}

test("successive failed Review jobs preserve separate patches and automatically offer both to the next writer", () => {
  // Inject the timeout result, rather than waiting for the wall-clock limit.
  // Unlike seedRecovery, the real job must produce all recovery metadata.
  const timeout = {
    type: "message_end",
    message: {
      role: "assistant",
      errorMessage: "timed out before it exited",
    },
  };
  const at = setUp(reviewReplies(), {
    untracked: "repo/first.txt",
    events: [timeout],
  });
  const first = runJob(at, ["--stage", "review"]);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.stdout.includes("the hardening session failed: timed out"));
  const { dropped, patch, manifest, patchBytes, manifestBytes } =
    savedEvidence(at);

  setScript(at, { untracked: "repo/second.txt", events: [timeout] });
  const second = runJob(at, ["--stage", "review"]);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(second.stdout.includes("the hardening session failed: timed out"));
  const secondTask = latestTask(at);
  assert.ok(secondTask.includes(patch));
  assert.ok(secondTask.includes(manifest));
  assert.ok(secondTask.includes("timed out before it exited"));
  assert.deepEqual(fs.readFileSync(patch), patchBytes);
  assert.deepEqual(fs.readFileSync(manifest), manifestBytes);
  const laterFiles = fs.readdirSync(dropped);
  const patches = laterFiles.filter((file) => file.endsWith("-repo.patch"));
  assert.equal(patches.length, 2);
  assert.equal(laterFiles.filter((file) => file.endsWith(".json")).length, 2);
  for (const file of patches) {
    const content = fs.readFileSync(path.join(dropped, file), "utf8");
    // Merely offering the first patch must not replay it into the second job.
    assert.notEqual(
      content.includes("first.txt"),
      content.includes("second.txt"),
    );
  }

  setScript(at, {
    events: [outputEnd({ outcome: "cannot", reason: "Need a product answer" })],
  });
  const third = runJob(at, ["--stage", "review"]);
  assert.equal(third.status, 0, third.stderr);
  const thirdTask = latestTask(at);
  for (const file of laterFiles) {
    assert.ok(thirdTask.includes(path.join(dropped, file)));
  }
  assert.ok(
    !logOf(at, "ops.log").some(({ op }) => ["verify", "ready-pr"].includes(op)),
  );
});

test("hardening and check-fix both get the pinned targeted-test policy and actual full gate before they start", () => {
  const replies = {
    ...reviewReplies(),
    verify: {
      ok: true,
      pass: false,
      headSha: HEAD_SHA,
      checks: [{ id: "test", pass: false, detail: "exit 1" }],
    },
  };
  const at = setUp(
    replies,
    {
      launches: [
        [outputEnd({ outcome: "done", summary: "targeted tests pass" })],
        [
          outputEnd({
            outcome: "cannot",
            reason: "outside service unavailable",
          }),
        ],
      ],
    },
    { commands: { test: "mise //apps/issue-pipeline:check" } },
  );
  fs.writeFileSync(path.join(at.prompts, "hardening.md"), PROMPT);
  const r = runJob(at, ["--stage", "review"]);
  assert.equal(r.status, 0, r.stderr);
  const starts = piStarts(at);
  assert.equal(starts.length, 2);
  for (const start of starts) {
    assert.equal(flagValue(start.argv, "--append-system-prompt"), PROMPT);
  }
  const tasks = logOf(at, "pi.log")
    .filter(({ command }) => command?.type === "prompt")
    .map(({ command }) => command.message);
  assert.ok(tasks[0].includes("Task: `hardening`"));
  assert.ok(tasks[1].includes("Task: `check-fix`"));
  for (const task of tasks) {
    assert.ok(
      task.includes('commands.test: "mise //apps/issue-pipeline:check"'),
    );
  }
  assert.ok(!logOf(at, "ops.log").some(({ op }) => op === "ready-pr"));
});
