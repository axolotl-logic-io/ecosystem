// @ts-check
// Untrusted rows retain accounting data but never acquire trusted revisions.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED,
  cfg,
  fakeGh,
  inputsOf,
  leaseOf,
  NOW,
  openWith,
  resetRuns,
  VISITOR,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { readQueue } = await import("../src/orchestrator/snapshot.ts");
const { planOf } = await import("../src/orchestrator/issue-plan.ts");
const { schedule } = await import("../src/orchestrator/schedule.ts");
const { newIssueState } = await import("../src/state.ts");
/** @type {import("../src/orchestrator/queue.ts").ScheduleSettings} */
const SETTINGS = {
  maxJobs: 2,
  stageCaps: {},
  maxResumes: 2,
  skipLabels: [],
  takeNewWork: true,
  leaseMs: 1000,
};

const AUTHOR_REFUSAL =
  /issue author @alice is not on allowedUsers or not a collaborator/u;
const TRUSTED_ISSUE = 3;
const LIVE_ISSUE = 5;
const LIVE_PID = 500;
const LEGACY_PID = 600;

/** @param {readonly number[]} [pids] @returns {import("../src/orchestrator/snapshot.ts").Queue} */
function read(pids = []) {
  return readQueue(cfg, {
    alive: (pid) => pids.includes(pid),
    starts: [],
    mergeWindow: null,
  });
}

test("visitor and non-collaborator rows are observed without trusted hashes or scheduling", () => {
  resetRuns();
  openWith(
    [
      { number: 1, author: VISITOR },
      {
        number: 2,
        author: ALLOWED,
        state: { ...newIssueState(2), stage: "review" },
      },
    ],
    [{ when: `collaborators/${ALLOWED}`, code: 1, keep: true }],
  );
  const { snapshot } = read();
  assert.equal(snapshot.issues.length, 2);
  for (const issue of snapshot.issues) {
    assert.equal(issue.authorAllowed, false);
    assert.equal(issue.inputs, null);
    assert.deepEqual(planOf(issue, SETTINGS, NOW), { kind: "none" });
  }
});

test("a trusted row hashes its actual author and revocation prevents reauthoring on the next snapshot", () => {
  resetRuns();
  const row = {
    number: TRUSTED_ISSUE,
    author: ALLOWED,
    state: { ...newIssueState(TRUSTED_ISSUE), stage: "review" },
  };
  openWith([row]);
  const [trusted] = read().snapshot.issues;
  assert.ok(trusted);
  assert.equal(trusted.authorAllowed, true);
  assert.equal(trusted.inputs?.current, inputsOf(row));
  assert.equal(planOf(trusted, SETTINGS, NOW).kind, "run");
  openWith(
    [{ ...row, body: "Revoked requirements" }],
    [{ when: `collaborators/${ALLOWED}`, code: 1, keep: true }],
  );
  const [revoked] = read().snapshot.issues;
  assert.ok(revoked);
  assert.equal(revoked.inputs, null);
  assert.deepEqual(planOf(revoked, SETTINGS, NOW), { kind: "none" });
  assert.ok(
    fakeGh
      .calls()
      .some((args) => args.includes(`repos/o/r/collaborators/${ALLOWED}`)),
  );
});

test("missing inputs cannot schedule an otherwise trusted issue", () => {
  resetRuns();
  openWith([{ number: 4 }]);
  const [issue] = read().snapshot.issues;
  assert.ok(issue);
  assert.deepEqual(
    planOf({ ...issue, authorAllowed: true, inputs: null }, SETTINGS, NOW),
    { kind: "none" },
  );
});

test("untrusted live and legacy jobs and leases remain visible and consume global capacity", () => {
  resetRuns();
  const lease = leaseOf("other");
  writeJob({ issue: LIVE_ISSUE, stage: "review", pid: LIVE_PID });
  writeJob({ issue: 6, stage: "implement", pid: LEGACY_PID, legacy: true });
  openWith([
    {
      number: LIVE_ISSUE,
      author: VISITOR,
      state: { ...newIssueState(LIVE_ISSUE), lease },
    },
    { number: 6, author: VISITOR },
    { number: 7 },
  ]);
  const { snapshot } = read([LIVE_PID, LEGACY_PID]);
  const [live, legacy] = snapshot.issues;
  assert.ok(live);
  assert.ok(legacy);
  assert.equal(live.inputs, null);
  assert.equal(live.job?.live, true);
  assert.deepEqual(live.state?.lease, lease);
  assert.equal(legacy.legacyLive, true);
  assert.equal(legacy.inputs, null);
  const result = schedule(snapshot, SETTINGS, {
    now: NOW,
    resumes: {},
    gate: null,
  });
  assert.deepEqual(
    result.decisions.map(({ issue, reason }) => ({ issue, reason })),
    [{ issue: 7, reason: "global-cap" }],
  );
});

test("normalizing a trusted list row keeps its real author for the hash boundary's fresh check", () => {
  resetRuns();
  openWith(
    [{ number: TRUSTED_ISSUE, author: ALLOWED }],
    [
      { when: `collaborators/${ALLOWED}` },
      { when: `collaborators/${ALLOWED}`, code: 1, keep: true },
    ],
  );
  assert.throws(() => read(), AUTHOR_REFUSAL);
});
