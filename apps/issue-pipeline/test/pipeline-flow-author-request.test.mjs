// @ts-check
// Existing direct work opts into Author through built jobs and the real claim.
// Local git and scripted GitHub/pi stand in for external services only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ISSUE_STATE } from "../src/state.ts";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run-test-kit.mjs";
import {
  authorTurn,
  hardeningTurn,
  implementorTurn,
  openFlowIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script-test-kit.mjs";
import { ISSUE, scriptPi, setUpFlow } from "./pipeline-flow-test-kit.mjs";

/** @type {import('./pipeline-flow-test-kit.mjs').Flow} */
let flow;
/** @type {import('../src/state.ts').IssueState | null} */
let checkpoint = null;
const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    When they arrive\n    Then they see a polite greeting";

function state() {
  return ISSUE_STATE.parse(savedState(readWorld(flow.ghDir)));
}
function starts() {
  return piLog(flow.piDir).filter((entry) => entry.start === true);
}

before(() => {
  flow = setUpFlow();
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    implementor: [implementorTurn("Hello, world!", "Greet visitors")],
    author: [
      { output: {}, rejectPrompt: "read ECONNRESET" },
      authorTurn(GHERKIN, false),
    ],
    reviewer: [hardeningTurn(), securityTurn()],
  });
});
after(() => stopJobs(flow));

test("direct Developer work establishes its PR/head before the explicit Author pass", () => {
  assert.equal(runStage(flow, "implement").end, "next");
  checkpoint = state();
  assert.equal(checkpoint.stage, "review");
  assert.equal(checkpoint.authorUsed, false);
  assert.equal(checkpoint.gherkin, null);
  assert.ok(checkpoint.pr);
  assert.ok(checkpoint.headSha);
});

test("an interrupted explicit Author run durably retains its checkpoint through the real claim", () => {
  assert.ok(checkpoint);
  assert.equal(runStage(flow, "author").end, "deferred");
  const saved = state();
  assert.equal(saved.stage, "author");
  assert.equal(saved.resumeStage, "review");
  assert.equal(saved.authorUsed, true);
  assert.equal(saved.pr, checkpoint.pr);
  assert.equal(saved.branch, checkpoint.branch);
  assert.equal(saved.headSha, checkpoint.headSha);
  assert.equal(saved.requirementsInputs, checkpoint.requirementsInputs);
  assert.equal(saved.hardened, null);
  assert.equal(saved.security, null);
});

test("the resumed Author posts its first Gherkin and returns to the retained Review checkpoint without approval", () => {
  assert.ok(checkpoint);
  assert.equal(runStage(flow, "author").end, "next");
  const saved = state();
  assert.equal(saved.stage, "review");
  assert.equal(saved.resumeStage, null);
  assert.equal(saved.pr, checkpoint.pr);
  assert.equal(saved.headSha, checkpoint.headSha);
  assert.equal(saved.gherkin?.rev, 1);
  assert.equal(saved.hardened, null);
  assert.equal(saved.security, null);
  const authors = starts().filter(({ role }) => role === "author");
  assert.equal(authors.length, 2);
  assert.deepEqual(
    authors.map(({ commitScope }) => commitScope),
    [false, false],
  );
  assert.deepEqual(
    authors.map(({ ghToken }) => ghToken),
    [null, null],
  );
});

test("the original work still needs real hardening, verification and Security before completion", () => {
  assert.equal(runStage(flow, "review").end, "next");
  assert.equal(runStage(flow, "merge").end, "next");
  const saved = state();
  assert.equal(saved.stage, "done");
  assert.ok(saved.hardened);
  assert.ok(saved.merged);
  assert.deepEqual(saved.security?.revision, saved.merged);
  assert.deepEqual(readWorld(flow.ghDir).unsupported, []);
});

test("an explicit Author invocation cannot reopen completed work or start another model", () => {
  const completed = state();
  withWorld(flow.ghDir, (world) => {
    const issue = world.issues.find(({ number }) => number === ISSUE);
    Object.assign(issue ?? {}, {
      state: "open",
      stateReason: null,
      labels: [],
    });
  });
  const sessions = starts().length;
  assert.equal(runStage(flow, "author").end, "unclaimed");
  assert.equal(starts().length, sessions);
  assert.equal(state().stage, "done");
  assert.deepEqual(state().merged, completed.merged);
  assert.deepEqual(state().security, completed.security);
});
