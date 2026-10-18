// @ts-check
// The tests' bounds (bounded-test-kit.mjs, #372): a test that never resolves
// fails at the per-test timeout, by name, and leaves no job or pi running; a
// wait that never holds fails naming what it waited for; and the logs read
// only complete lines. Fixtures go in a temporary folder, never under test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { alive, waitFor } from "./bounded-test-kit.mjs";
import { READER_STAGE, repliesAt } from "./job-fixtures.mjs";
import { logOf, setUp } from "./job-test-kit.mjs";

const BOUNDED_KIT = new URL("./bounded-test-kit.mjs", import.meta.url).href;
const JOB_KIT = new URL("./job-test-kit.mjs", import.meta.url).href;
const JOB_FIXTURES = new URL("./job-fixtures.mjs", import.meta.url).href;
const HUNG_TEST = "a test whose job waits and that never resolves";
// The fixture's per-test timeout. It covers setting up a place and the job
// reaching pi's prompt, whose wait in the fixture took 3.2 s at worst, in a
// full `node --test` run beside three more in a copy of the checkout, at
// 1-minute load averages of up to 130 on 10 cores (2026-10-17). It is over 3
// times that and a setUp.
const FIXTURE_TIMEOUT_MS = 20_000;
// The nested run's bound: the fixture's timeout, plus 20 s for starting node
// twice and the cleanup, with room to spare. A nested run that a leaked job keeps alive
// is killed here instead, below this test's own timeout (mise.toml).
const NESTED_RUN_MS = 40_000;
// waitFor's deadline in the test of a wait that never holds, and that test's
// own timeout, so it can't hang even if waitFor never settles.
const SHORT_WAIT_MS = 50;
const SHORT_TEST_MS = 5000;
const THE_MARKER = /the marker/u;
const TIMED_OUT = new RegExp(
  `^not ok 1 - ${HUNG_TEST}\\n[\\s\\S]*timed out`,
  "mu",
);

// Waits for pi to get the prompt, records the job's and pi's pids in the file
// FIXTURE_PIDS names, as job.json and pi.log give them, then never resolves.
const FIXTURE = `import fs from "node:fs";
import { test } from "node:test";
import { waitFor } from ${JSON.stringify(BOUNDED_KIT)};
import { READER_STAGE, repliesAt } from ${JSON.stringify(JOB_FIXTURES)};
import { piCommands, piStarts, setUp, startJob, statusOf } from ${JSON.stringify(JOB_KIT)};
test(${JSON.stringify(HUNG_TEST)}, async () => {
  const place = setUp(repliesAt(READER_STAGE), { events: ["wait"] });
  startJob(place, ["--stage", READER_STAGE, "--lane", "L"]);
  await waitFor("pi got the prompt", () => piCommands(place).some(({ type }) => type === "prompt"));
  const pids = { job: statusOf(place).pid, pis: piStarts(place).map(({ pid }) => pid) };
  fs.writeFileSync(process.env.FIXTURE_PIDS, JSON.stringify(pids));
  await new Promise(() => undefined);
});
`;

/**
 * Runs `body` with a fresh temporary folder, then removes the folder.
 * @param {(dir: string) => void} body
 * @returns {void}
 */
function inTempDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-bound-"));
  try {
    body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The pids the fixture recorded, or none if it recorded none.
 * @param {string} file
 * @returns {{ job: number, pis: number[] }}
 */
function pidsIn(file) {
  if (!fs.existsSync(file)) {
    return { job: 0, pis: [] };
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** @param {{ job: number, pis: number[] }} pids */
function killAll({ job, pis }) {
  for (const pid of [job, ...pis].filter((p) => p > 0 && alive(p))) {
    process.kill(pid, "SIGKILL");
  }
}

/**
 * Runs node --test on `fixture` with FIXTURE_TIMEOUT_MS, with no test
 * context of its own, as a run of its own.
 * @param {string} fixture
 * @param {string} pidsFile
 */
function runNested(fixture, pidsFile) {
  const env = Object.fromEntries([
    ...Object.entries(process.env).filter(
      ([name]) => name !== "NODE_TEST_CONTEXT",
    ),
    ["FIXTURE_PIDS", pidsFile],
  ]);
  const timeout = `--test-timeout=${FIXTURE_TIMEOUT_MS}`;
  return spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", timeout, fixture],
    {
      encoding: "utf8",
      env,
      timeout: NESTED_RUN_MS,
      killSignal: "SIGKILL",
    },
  );
}

test("a test that never resolves fails at the per-test timeout, by name, and leaves no job or pi running", () => {
  inTempDir((dir) => {
    const fixture = path.join(dir, "hung.test.mjs");
    const pidsFile = path.join(dir, "pids.json");
    fs.writeFileSync(fixture, FIXTURE);
    try {
      const r = runNested(fixture, pidsFile);
      const output = `${r.stdout}${r.stderr}`;
      assert.equal(r.error, undefined, output);
      assert.equal(r.signal, null, output);
      assert.notEqual(r.status, 0, output);
      assert.match(r.stdout, TIMED_OUT);
      const { job, pis } = pidsIn(pidsFile);
      assert.ok(job > 0, output);
      assert.notDeepEqual(pis, [], output);
      assert.deepEqual(
        [job, ...pis].map((pid) => alive(pid)),
        [job, ...pis].map(() => false),
      );
    } finally {
      killAll(pidsIn(pidsFile));
    }
  });
});

test("waitFor fails naming its condition when it never holds", {
  timeout: SHORT_TEST_MS,
}, async () => {
  await assert.rejects(
    waitFor("the marker", () => false, SHORT_WAIT_MS),
    THE_MARKER,
  );
});

test("logOf skips a line still being written", () => {
  const place = setUp(repliesAt(READER_STAGE), { events: [] });
  const entry = { command: { type: "prompt" } };
  fs.writeFileSync(
    path.join(place.root, "pi.log"),
    `${JSON.stringify(entry)}\n{"argv":["--sess`,
  );
  assert.deepEqual(logOf(place, "pi.log"), [entry]);
});
