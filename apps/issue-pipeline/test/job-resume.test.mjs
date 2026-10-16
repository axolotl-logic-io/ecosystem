// Resuming a stopped stage job with --resume: an interrupted session with
// its file on disk is reopened, and one without it starts fresh.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  flagValue,
  logOf,
  piCommands,
  piStarts,
  READY_SPEC,
  repliesAt,
  runJob,
  SPEC_SESSION,
  setScript,
  setUp,
  startJob,
  statusOf,
  USAGE,
  USAGE_TOTAL,
  waitFor,
} from "./job-test-kit.mjs";

const STAGE_ARGS = ["--stage", "spec", "--lane", "L"];
const INTERRUPTED = /interrupted/u;
// SIGTERM's exit code: 128 + 15.
const STOPPED_BY_SIGTERM = 143;

function sessionOf(status) {
  return status?.launches.find(({ kind }) => kind === "session") ?? null;
}

// A spec job stopped while its session waits, after it spent USAGE.
async function stoppedJob() {
  const place = setUp(repliesAt("spec"), {
    events: [messageEnd(USAGE), "wait", outputEnd(READY_SPEC)],
  });
  const job = startJob(place, STAGE_ARGS);
  await waitFor(() => sessionOf(statusOf(place))?.usage.input > 0);
  job.child.kill("SIGTERM");
  const end = await job.end;
  setScript(place, SPEC_SESSION);
  return { place, end };
}

function releaseOf(place) {
  return logOf(place, "ops.log").find(({ op }) => op === "release");
}

test("--resume reopens the interrupted session with the resume prompt and counts its tokens once", async () => {
  const { place, end } = await stoppedJob();
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  const r = runJob(place, [...STAGE_ARGS, "--resume"]);
  assert.equal(r.status, 0, r.stderr);
  const [first, second] = piStarts(place);
  const session = flagValue(first.argv, "--session");
  assert.equal(flagValue(second.argv, "--session"), session);
  assert.equal(second.fresh, false);
  const prompts = piCommands(place).filter(({ type }) => type === "prompt");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].message, INTERRUPTED);
  assert.notEqual(prompts[1].message, prompts[0].message);
  assert.deepEqual(
    fs.readdirSync(path.dirname(session)).filter((f) => f.endsWith(".jsonl")),
    [path.basename(session)],
  );
  assert.equal(releaseOf(place).state.reportedTokens, 2 * USAGE_TOTAL);
  const launch = sessionOf(statusOf(place));
  assert.equal(launch.resumed, true);
  assert.equal(launch.usage.input, 2 * USAGE.input);
});

test("--resume starts a launch whose session file is gone afresh", async () => {
  const { place, end } = await stoppedJob();
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  const { session } = sessionOf(statusOf(place));
  fs.rmSync(session);
  const r = runJob(place, [...STAGE_ARGS, "--resume"]);
  assert.equal(r.status, 0, r.stderr);
  const [, second] = piStarts(place);
  assert.equal(second.fresh, true);
  const prompts = piCommands(place).filter(({ type }) => type === "prompt");
  assert.equal(prompts[1].message, prompts[0].message);
  assert.equal(releaseOf(place).state.reportedTokens, USAGE_TOTAL);
  assert.equal(sessionOf(statusOf(place)).resumed, false);
});

test("--resume with no earlier job.json runs the stage as a fresh job", () => {
  const place = setUp(repliesAt("spec"), SPEC_SESSION);
  const r = runJob(place, [...STAGE_ARGS, "--resume"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(piStarts(place)[0].fresh, true);
  assert.equal(releaseOf(place).state.reportedTokens, USAGE_TOTAL);
});
