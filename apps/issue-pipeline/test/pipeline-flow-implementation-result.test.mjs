// @ts-check
// Implementation's task result (#118) and the fix return edited requirements
// force (#172), through built jobs. The landing account records a passed
// Implementation bound to the requirements digest and the target, naming the
// pushed revision R, before the work moves to review; Hardening is ready only
// while that result is current. A trusted comment that edits the
// requirements after Hardening stales it, so the work goes back to
// Implementation, which records a fresh result before fresh Hardening. Local
// Git, the stateful fake GitHub and the scripted fake pi stand in for the
// services; every effect is read from them.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  postComment,
  readWorld,
  withWorld,
} from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run-test-kit.mjs";
import {
  hardeningTurn,
  implementorTurn,
  openFlowIssue,
  savedState,
} from "./pipeline-flow-script-test-kit.mjs";
import {
  BASE,
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.mjs";

const BRANCH = `refs/heads/agent/issue-${ISSUE}`;
const TARGET = `refs/heads/${BASE}`;
const LAWD = "bot";
const DEV = "dev-bot";
const MARK = "<!-- agent-pipeline:task-result\n";
const REQUIREMENTS_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const NOT_LANDING = /not the landing account's own record/u;
const NO_IMPLEMENTATION =
  /no Implementation result is current for the requirements/u;
const REQUIREMENTS_REVIEW = /trusted inputs need requirements review/u;
// Two runs of a task, each an attempt and its result.
const TWO_RUNS = 4;

/** @type {import("./pipeline-flow-test-kit.mjs").Flow[]} */
const flows = [];
after(() => {
  for (const flow of flows) {
    stopJobs(flow);
  }
});

/**
 * A flow with the issue open and its model turns scripted.
 * @param {Record<string, unknown[]>} script
 */
function opened(script) {
  const flow = setUpFlow();
  flows.push(flow);
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, script);
  return flow;
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow */
function starts(flow) {
  return piLog(flow.piDir).filter((entry) => entry.start === true).length;
}

/**
 * The task-result records on GitHub, parsed, with their author and body.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @returns {any[]}
 */
function records(flow) {
  return readWorld(flow.ghDir)
    .comments.filter(({ body }) => body.startsWith(MARK))
    .map(({ body, login }) => ({
      login,
      body,
      ...JSON.parse(body.slice(MARK.length, -"\n-->".length)),
    }));
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @param {string} task */
function recordsOf(flow, task) {
  return records(flow).filter(({ binding }) => binding.task === task);
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow */
function stage(flow) {
  return savedState(readWorld(flow.ghDir)).stage;
}

/**
 * Removes the Implementation records and returns their bodies.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @returns {string[]}
 */
function dropImplementation(flow) {
  const bodies = recordsOf(flow, "Implementation").map(({ body }) => body);
  withWorld(flow.ghDir, (world) => {
    world.comments = world.comments.filter(
      ({ body }) => !bodies.includes(body),
    );
  });
  return bodies;
}

test("Lawd records Implementation's result for the requirements and target, naming R, and a run interrupted after the save repeats nothing", () => {
  const flow = opened({
    implementor: [implementorTurn("Hello, world!", "Greet visitors")],
    reviewer: [hardeningTurn()],
  });
  const target = refIn(flow.origin, TARGET);
  assert.equal(runStage(flow, "implement").end, "next");
  const implemented = refIn(flow.origin, BRANCH);
  assert.equal(stage(flow), "review");
  const [attempt, result, ...rest] = records(flow);
  assert.deepEqual(rest, []);
  for (const record of [attempt, result]) {
    assert.equal(record.login, LAWD, "only the landing account records");
    assert.equal(record.binding.task, "Implementation");
    assert.equal("revision" in record.binding, false);
    assert.match(record.binding.requirements, REQUIREMENTS_DIGEST);
    assert.deepEqual(record.binding.target, { branch: BASE, commit: target });
  }
  assert.deepEqual([attempt.kind, result.kind], ["attempt", "result"]);
  assert.equal(result.run.id, attempt.run.id);
  assert.equal(result.verdict, "passed");
  assert.equal(result.receipt.produced.code, implemented);

  // The caller restarts before starting review and retries implement: the
  // saved stage says review, so nothing runs, pushes or records again.
  const sessions = starts(flow);
  assert.notEqual(runStage(flow, "implement").end, "next");
  assert.equal(starts(flow), sessions);
  assert.equal(refIn(flow.origin, BRANCH), implemented);
  assert.equal(records(flow).length, 2);

  // Review reads the result fresh and hardens without another Developer run.
  assert.equal(runStage(flow, "review").end, "next");
  assert.equal(starts(flow), sessions + 1, "only the Hardening session ran");
  assert.equal(stage(flow), "merge");
  assert.equal(recordsOf(flow, "Implementation").length, 2);
  assert.equal(recordsOf(flow, "Hardening").length, 2);
});

test("Hardening isn't ready without a current Implementation result: review returns the work to implement before any session", () => {
  const flow = opened({
    implementor: [
      implementorTurn("Hello, world!", "Greet visitors"),
      implementorTurn("Hello, world!", "Greet visitors again"),
    ],
    reviewer: [hardeningTurn()],
  });
  assert.equal(runStage(flow, "implement").end, "next");
  // Work no Implementation result vouches for, such as a push from before
  // Implementation recorded one.
  dropImplementation(flow);
  const sessions = starts(flow);
  assert.equal(runStage(flow, "review").end, "next");
  const returned = savedState(readWorld(flow.ghDir));
  assert.equal(returned.stage, "implement");
  assert.match(returned.log.join("\n"), NO_IMPLEMENTATION);
  assert.equal(starts(flow), sessions, "no Hardening session ran");
  assert.deepEqual(records(flow), []);

  // Implementation runs again and records its result; then Hardening runs.
  assert.equal(runStage(flow, "implement").end, "next");
  assert.equal(recordsOf(flow, "Implementation").length, 2);
  assert.equal(runStage(flow, "review").end, "next");
  assert.equal(stage(flow), "merge");
  assert.equal(starts(flow), sessions + 2);
});

test("an Implementation result the development account forges grants nothing: review holds before any session", () => {
  const flow = opened({
    implementor: [implementorTurn("Hello, world!", "Greet visitors")],
    reviewer: [hardeningTurn()],
  });
  assert.equal(runStage(flow, "implement").end, "next");
  // The development account posts Lawd's exact records as its own.
  const bodies = dropImplementation(flow);
  withWorld(flow.ghDir, (world) => {
    for (const body of bodies) {
      postComment(world, ISSUE, DEV, body);
    }
  });
  const sessions = starts(flow);
  const line = runStage(flow, "review");
  assert.equal(line.end, "stop");
  assert.match(line.reason, NOT_LANDING);
  assert.equal(starts(flow), sessions, "no Hardening session ran");
  assert.deepEqual(
    records(flow).map(({ login }) => login),
    [DEV, DEV],
    "nothing was recorded on top of the forgery",
  );
  assert.equal(savedState(readWorld(flow.ghDir)).hardened, null);
});

test("a trusted comment that edits the requirements after Hardening sends the work back to Implementation, whose fresh result precedes fresh Hardening", () => {
  const flow = opened({
    implementor: [
      implementorTurn("Hello, world!", "Greet visitors"),
      implementorTurn("Hello, polite world!", "Greet politely"),
    ],
    reviewer: [hardeningTurn(), hardeningTurn()],
  });
  for (const run of ["implement", "review"]) {
    assert.equal(runStage(flow, run).end, "next");
  }
  assert.equal(stage(flow), "merge");
  const [first] = recordsOf(flow, "Implementation");
  const [hardened] = recordsOf(flow, "Hardening");
  const firstHead = refIn(flow.origin, BRANCH);

  withWorld(flow.ghDir, (world) => {
    postComment(world, ISSUE, "alice", "Please greet politely instead.");
  });
  const sessions = starts(flow);
  assert.equal(runStage(flow, "merge").end, "next");
  const returned = savedState(readWorld(flow.ghDir));
  assert.equal(returned.stage, "implement");
  assert.match(returned.log.join("\n"), REQUIREMENTS_REVIEW);
  assert.equal(starts(flow), sessions, "merge started no session");

  assert.equal(runStage(flow, "implement").end, "next");
  const head = refIn(flow.origin, BRANCH);
  assert.notEqual(head, firstHead);
  const implementations = recordsOf(flow, "Implementation");
  assert.equal(implementations.length, TWO_RUNS);
  const fresh = implementations.at(-1);
  assert.notEqual(fresh.binding.requirements, first.binding.requirements);
  assert.equal(fresh.verdict, "passed");
  assert.equal(fresh.receipt.produced.code, head);

  assert.equal(runStage(flow, "review").end, "next");
  assert.equal(stage(flow), "merge");
  const hardenings = recordsOf(flow, "Hardening");
  assert.equal(hardenings.length, TWO_RUNS, "the old Hardening stays");
  assert.deepEqual(hardenings[0], hardened);
  const latest = hardenings.at(-1);
  assert.notEqual(
    latest.binding.revision.inputs,
    hardened.binding.revision.inputs,
  );
  assert.equal(
    fresh.binding.requirements,
    `sha256:${latest.binding.revision.inputs}`,
  );
  assert.equal(latest.binding.revision.code, refIn(flow.origin, BRANCH));
});
