// @ts-check
// One opt-in assignment sweep (#120): it reads the repo's open issues in
// full, starts the work the grantor's assignments grant through the
// caller's own launcher, and holds the rest. The installed sweep.mjs,
// caller launcher, job and ops run for real against the fake GitHub, a
// local origin and fake pi.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GRANTOR,
  HIPPY,
  optIn,
  runFolder,
  startedJobs,
  sweep,
} from "./assignment-test-kit.mjs";
import { openIssue } from "./fake-pipeline-flow-gh.mjs";
import {
  assignIssue,
  cutListing,
} from "./fake-pipeline-flow-gh-assignments.mjs";
import { readWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import {
  implementorTurn,
  savedState,
} from "./pipeline-flow-script-test-kit.mjs";
import { scriptPi, setUpFlow } from "./pipeline-flow-test-kit.mjs";

const FIRST = 7;
const SECOND = 8;
const BY_ALICE = 9;
const UNASSIGNED = 10;
const SESSIONS = 3;
const REVIEW_FLAGS = ["--hardening-buddy", "hippy", "--assignment"];
const REFUSED = /^refused: /u;

/**
 * An opted-in flow with issues 7 and 8 assigned to Hippy by the grantor,
 * 9 assigned to Hippy by alice (not the grantor) and 10 assigned to nobody.
 */
function sweptFlow() {
  const flow = setUpFlow();
  optIn(flow);
  for (const number of [FIRST, SECOND, BY_ALICE, UNASSIGNED]) {
    const body = `Say hello to visitor ${number}.`;
    openIssue(flow.ghDir, { number, title: "Greet", body, login: "alice" });
  }
  assignIssue(flow.ghDir, FIRST, HIPPY, GRANTOR);
  assignIssue(flow.ghDir, SECOND, HIPPY, GRANTOR);
  assignIssue(flow.ghDir, BY_ALICE, HIPPY, "alice");
  return flow;
}

/** @param {any[]} decisions */
function byIssue(decisions) {
  return Object.fromEntries(decisions.map((each) => [each.issue, each]));
}

test("one sweep starts the granted work, holds the rest and keeps under the run's caps", async () => {
  const flow = sweptFlow();
  scriptPi(flow, {
    implementor: [
      implementorTurn("Hello, 7!", "Greet 7"),
      // Hardening of 7 and Implementation of 8 run at once and may take
      // either turn: each commits a greeting.
      implementorTurn("Hello, there!", "Greet"),
      implementorTurn("Hello, there!", "Greet"),
    ],
  });
  const first = byIssue(sweep(flow, runFolder(flow, { maxJobs: 1 })));
  assert.deepEqual(
    Object.keys(first),
    [FIRST, SECOND, BY_ALICE].map(String),
    `${UNASSIGNED} isn't assigned`,
  );
  assert.equal(first[FIRST].start.stage, "implement");
  assert.match(first[SECOND].hold, REFUSED, "the cap holds 8");
  assert.equal(
    first[BY_ALICE].hold,
    `paused: ${GRANTOR} hasn't assigned ${HIPPY}`,
  );
  const [implemented] = await startedJobs(flow, Object.values(first));
  assert.ok(implemented !== undefined);
  assert.ok(implemented.launch.argv.includes("--assignment"));
  assert.equal(implemented.line.end, "next");
  assert.equal(savedState(readWorld(flow.ghDir), FIRST).stage, "review");
  const second = byIssue(sweep(flow, runFolder(flow, { maxJobs: 2 })));
  assert.equal(second[FIRST].start.stage, "review");
  assert.equal(second[SECOND].start.stage, "implement");
  assert.equal(second[BY_ALICE].start, undefined);
  const jobs = await startedJobs(flow, Object.values(second));
  const review = jobs.find(({ launch }) => launch.issue === FIRST);
  assert.deepEqual(
    review?.launch.argv.slice(-REVIEW_FLAGS.length),
    REVIEW_FLAGS,
  );
  assert.deepEqual(
    jobs.map(({ line }) => line.end),
    ["next", "next"],
  );
  const started = piLog(flow.piDir).filter((entry) => entry.start === true);
  assert.equal(started.length, SESSIONS, "one session per started job");
});

test("a cut-short listing holds the whole repo: nothing starts from it", () => {
  const flow = sweptFlow();
  cutListing(flow.ghDir, "issues");
  const decisions = sweep(flow, runFolder(flow, { maxJobs: 2 }));
  assert.deepEqual(decisions, [
    {
      sweep: 1,
      repo: "o/r",
      issue: null,
      hold: "the open-issue listing was cut short; nothing starts from it",
    },
  ]);
  assert.deepEqual(
    piLog(flow.piDir).filter((entry) => entry.start === true),
    [],
  );
});

test("a repo without a grantor isn't swept", () => {
  const flow = setUpFlow();
  const decisions = sweep(flow, runFolder(flow, { maxJobs: 1 }));
  assert.deepEqual(decisions, [
    {
      sweep: 1,
      repo: "o/r",
      issue: null,
      hold: "assignment mode isn't enabled for o/r (assignments.grantor)",
    },
  ]);
});
