// @ts-check
// The scheduler and its start gate with only some roles running (#417): an
// issue whose next stage belongs to a role that isn't running is held
// `role-off:<role>`, a hold of its own (an after mark, another lane) keeps
// its reason, and a role that is off frees none of the caps, while a
// role-off hold counts toward none of them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { schedule, startGate } from "../src/orchestrator/schedule.ts";
import { ROLE_NAMES } from "../src/roles/registry.ts";
import {
  CAPPED,
  issue,
  LIVE_JOB,
  NOW,
  READERS,
  SETTINGS,
  snapshotOf,
} from "./orchestrator-fixtures.mjs";

/** @import { ScheduleSettings, Snapshot } from "../src/orchestrator/queue.ts" */
/** @import { RoleName } from "../src/roles/registry.ts" */

/** @type {RoleName[]} */
const TRIAGE_ONLY = ["triage"];

// The start gate's issues: a fix, and two triages for one place.
const GATED = { fix: 12, first: 13, second: 14 };

// One issue at a stage of each role.
const ONE_PER_ROLE = snapshotOf([
  issue({ number: 1, stage: "triage" }),
  issue({ number: 2, stage: "spec" }),
  issue({ number: 3, stage: "fix", pr: 30 }),
  issue({ number: 4, stage: "review", pr: 40 }),
  issue({ number: 5, stage: "publish", pr: 50 }),
]);

// Each decision as `#issue stage action reason`, in the order made.
/** @param {Snapshot} snapshot @param {ScheduleSettings} settings @returns {string[]} */
function decided(snapshot, settings) {
  return schedule(snapshot, settings, NOW).map(
    ({ issue: number, stage, action, reason }) =>
      `#${number} ${stage} ${action} ${reason}`,
  );
}

test("with only triage running, every other role's issue is held role-off:<role> and the triage issue starts", () => {
  assert.deepEqual(decided(ONE_PER_ROLE, { ...SETTINGS, roles: TRIAGE_ONLY }), [
    "#5 publish held role-off:finalizer",
    "#3 fix held role-off:implementor",
    "#4 review held role-off:reviewer",
    "#2 spec held role-off:spec-writer",
    "#1 triage started free",
  ]);
});

test("with every role running, or no roles set, the scheduler decides as before", () => {
  const all = decided(READERS, { ...SETTINGS, roles: ROLE_NAMES });
  assert.deepEqual(all, decided(READERS, SETTINGS));
  assert.ok(all.every((line) => line.includes(" started ")));
});

test("an issue held for its after mark or another lane keeps that reason with its role off", () => {
  const snapshot = snapshotOf([
    issue({
      number: 6,
      stage: "review",
      verdict: { kind: "live-elsewhere", lane: "a" },
    }),
    issue({
      number: 7,
      stage: "spec",
      after: [1],
      verdict: { kind: "waiting-on-after" },
    }),
  ]);
  assert.deepEqual(decided(snapshot, { ...SETTINGS, roles: TRIAGE_ONLY }), [
    "#6 review held lane:a",
    "#7 spec held after:#1",
  ]);
});

test("live jobs of a role that is off still count toward maxJobs", () => {
  // Two live implementor jobs fill CAPPED's two places.
  const snapshot = snapshotOf([
    issue({ number: 8, stage: "implement", job: LIVE_JOB }),
    issue({ number: 9, stage: "fix", job: { live: true, stage: "fix" } }),
    issue({ number: 10, stage: "triage" }),
    issue({ number: 11, stage: "review" }),
  ]);
  assert.deepEqual(decided(snapshot, { ...CAPPED, roles: TRIAGE_ONLY }), [
    "#11 review held role-off:reviewer",
    "#10 triage held global-cap",
  ]);
});

test("an issue held role-off takes no place, so a later issue still gets the one place maxJobs leaves", () => {
  const snapshot = snapshotOf([
    issue({ number: 21, stage: "review", pr: 210 }),
    issue({ number: 22, stage: "triage" }),
  ]);
  assert.deepEqual(
    decided(snapshot, { ...SETTINGS, maxJobs: 1, roles: TRIAGE_ONLY }),
    ["#21 review held role-off:reviewer", "#22 triage started free"],
  );
});

test("the start gate holds a restart of a role that is off role-off:<role>, and doesn't count it", () => {
  const snapshot = snapshotOf([
    issue({ number: GATED.fix, stage: "fix" }),
    issue({ number: GATED.first, stage: "triage" }),
    issue({ number: GATED.second, stage: "triage" }),
  ]);
  const gate = startGate(snapshot, {
    ...SETTINGS,
    maxJobs: 1,
    roles: TRIAGE_ONLY,
  });
  assert.equal(gate(GATED.fix, "fix"), "role-off:implementor");
  assert.equal(gate(GATED.first, "triage"), null);
  assert.equal(gate(GATED.second, "triage"), "global-cap");
});
