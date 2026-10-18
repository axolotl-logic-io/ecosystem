// @ts-check
// A restarted stage job is always fresh (Reimagined-Pipeline): the job that
// follows one stopped mid-session claims the issue again and starts its
// session anew with the stage's own task, keeping the stopped session's file
// aside and counting only its own session's usage. The retired --resume and
// --stack-on flags are refused before any op.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { waitFor } from "./bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  AUTHOR_SESSION,
  AUTHORED,
  READER_STAGE,
  repliesAt,
  USAGE,
} from "./job-fixtures.mjs";
import {
  flagValue,
  logOf,
  piCommands,
  piStarts,
  runJob,
  sessionOf,
  setScript,
  setUp,
  startJob,
  statusOf,
} from "./job-test-kit.mjs";

const STAGE_ARGS = ["--stage", READER_STAGE, "--lane", "L"];
// SIGTERM's exit code: 128 + 15.
const STOPPED_BY_SIGTERM = 143;
const UNKNOWN_OPTION = /Unknown option '--(?:resume|stack-on)'/u;
const SET_ASIDE = /^author-1\.[0-9a-z]+\.jsonl$/u;

// An author job stopped while its session waits, after it spent USAGE; its
// next run's session ends with the Gherkin.
async function stoppedJob() {
  const place = setUp(repliesAt(READER_STAGE), {
    events: [messageEnd(USAGE), "wait", outputEnd(AUTHORED)],
  });
  const job = startJob(place, STAGE_ARGS);
  await waitFor(
    "the session's usage in job.json",
    () => sessionOf(statusOf(place))?.usage.input > 0,
  );
  job.child.kill("SIGTERM");
  const end = await job.end;
  setScript(place, AUTHOR_SESSION);
  return { place, end };
}

test("the job after a stopped one starts its session fresh with the stage's task and keeps the stopped one aside", async () => {
  const { place, end } = await stoppedJob();
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  const r = runJob(place, STAGE_ARGS);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).end, "next");
  const [first, second] = piStarts(place);
  const session = flagValue(first.argv, "--session");
  assert.equal(flagValue(second.argv, "--session"), session);
  assert.deepEqual([first.fresh, second.fresh], [true, true]);
  const prompts = piCommands(place).filter(({ type }) => type === "prompt");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].message, prompts[0].message);
  const aside = fs
    .readdirSync(path.dirname(session))
    .filter((name) => SET_ASIDE.test(name));
  assert.equal(aside.length, 1);
  const claims = logOf(place, "ops.log").filter(({ op }) => op === "claim");
  assert.equal(claims.length, 2);
  const launch = sessionOf(statusOf(place));
  assert.equal("resumed" in launch, false);
  assert.deepEqual(launch.usage, USAGE);
});

for (const flag of ["--resume", "--stack-on"]) {
  test(`a stage job refuses the retired ${flag} before any op`, () => {
    const place = setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
    const r = runJob(place, [...STAGE_ARGS, flag, "3"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, UNKNOWN_OPTION);
    assert.equal(r.stdout, "");
    assert.deepEqual(logOf(place, "ops.log"), []);
    assert.deepEqual(piStarts(place), []);
  });
}
