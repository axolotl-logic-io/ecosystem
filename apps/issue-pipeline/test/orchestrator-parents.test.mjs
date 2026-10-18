// @ts-check
// Split parents in the orchestrator (#378): each tick closes the open split
// parents whose sub-issues are all closed with at least one merged, through
// close-parent's own code, logs each close, escalates a close that fails and
// tries it again on the next tick, skips a parent another sweep reserved, and
// makes no scheduler decision for a parent.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { effectNames, effectsOf } from "./gh-effects.mjs";
import {
  CONFIG,
  cfg,
  fakeGh,
  NOW,
  openWith,
  runFile,
} from "./orchestrator-world-test-kit.mjs";

const { ghIsRead } = await import("../src/github.ts");
const { readQueue } = await import("../src/orchestrator/snapshot.ts");
const { tick } = await import("../src/orchestrator/tick.ts");

/** @import { GhReply } from "./fake-gh.mjs" */
/** @import { OpenIssue } from "./orchestrator-world-test-kit.mjs" */

// Each test's issues, its own since the kit's runs folder is shared.
const DONE = { parent: 80, merged: 81, dropped: 82 };
const OPEN = { parent: 83, sub: 84 };
const FAILS = { parent: 85, sub: 86 };
const RESERVED = { parent: 87 };
const NESTED = { outer: 88, inner: 89, leaf: 90 };
const VERDICT = { parent: 91 };
const SPLIT = ["agent:split"];
const LINE = z.looseObject({
  issue: z.number(),
  reason: z.string(),
  action: z.string().optional(),
  label: z.string().optional(),
});

// No job is due, so the tick spawns, steers, kills and consults nothing.
const NO_JOBS = {
  spawn: () => {
    throw new Error("unexpected spawn");
  },
  steer: () => {
    throw new Error("unexpected steer");
  },
  terminate: () => {
    throw new Error("unexpected SIGTERM");
  },
  runAgent: () => {
    throw new Error("unexpected escalation agent run");
  },
};

/** @param {number} number @param {string} state @param {string | null} reason @param {string[]} [labels] @returns {object} */
function sub(number, state, reason, labels = []) {
  return { number, state, reason, labels };
}

// gh's answer to close-parent's read of `parent`'s sub-issues.
/** @param {number} parent @param {readonly object[]} subs @returns {GhReply} */
function subsOf(parent, subs) {
  return { when: `issues/${parent}/sub_issues`, stdout: JSON.stringify(subs) };
}

// Runs one tick over the open `issues`, with `replies` queued after the
// queue's reads: its result and the names of its gh writes.
/** @param {readonly OpenIssue[]} issues @param {readonly GhReply[]} replies */
function tickOver(issues, replies) {
  openWith(issues, replies);
  const result = tick(cfg, { configPath: CONFIG, now: () => NOW, ...NO_JOBS });
  const effects = effectNames(effectsOf(fakeGh.writes(ghIsRead)));
  return { ...result, effects };
}

// The lines of runs file `name` about `issue`.
/** @param {string} name @param {number} issue @returns {z.infer<typeof LINE>[]} */
function linesOf(name, issue) {
  const file = runFile(name);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => LINE.parse(JSON.parse(line)))
    .filter((line) => line.issue === issue);
}

/** @param {number} issue @returns {number} */
function closedLines(issue) {
  return linesOf("orchestrator.log", issue).filter(
    ({ action }) => action === "closed-parent",
  ).length;
}

test("the queue reads an open agent:split issue as a split parent", () => {
  openWith([{ number: VERDICT.parent, labels: SPLIT }]);
  const { issues } = readQueue(cfg, [], NOW);
  assert.deepEqual(
    issues.map(({ verdict }) => verdict),
    [{ kind: "parent" }],
  );
});

test("a tick closes a parent whose sub-issues are all closed and one merged, logs it once, and makes no decision for it", () => {
  const subs = [
    sub(DONE.merged, "closed", "completed"),
    sub(DONE.dropped, "closed", "not_planned"),
  ];
  const { decisions, parents, effects } = tickOver(
    [{ number: DONE.parent, labels: SPLIT }],
    [subsOf(DONE.parent, subs)],
  );
  assert.deepEqual(parents, [{ issue: DONE.parent, outcome: "closed" }]);
  assert.deepEqual(decisions, []);
  assert.deepEqual(effects, [
    `comment #${DONE.parent} role=coordinator`,
    `issue close ${DONE.parent} -R o/r`,
    `label #${DONE.parent} agent:merged`,
    `unlabel #${DONE.parent} agent:split`,
  ]);
  assert.deepEqual(linesOf("orchestrator.log", DONE.parent), [
    {
      at: NOW.toISOString(),
      issue: DONE.parent,
      stage: "split",
      action: "closed-parent",
      reason: "sub-issues-done",
    },
  ]);
  const next = tickOver([], []);
  assert.deepEqual(next.effects, []);
  assert.equal(closedLines(DONE.parent), 1);
});

test("a parent with an open sub-issue waits, and the tick writes and logs nothing for it", () => {
  const subs = [sub(OPEN.sub, "open", null)];
  const { parents, effects } = tickOver(
    [{ number: OPEN.parent, labels: SPLIT }],
    [subsOf(OPEN.parent, subs)],
  );
  assert.deepEqual(
    parents.map(({ issue, outcome }) => ({ issue, outcome })),
    [{ issue: OPEN.parent, outcome: "waiting" }],
  );
  assert.deepEqual(effects, []);
  assert.deepEqual(linesOf("orchestrator.log", OPEN.parent), []);
});

test("a close that gh refuses is escalated with agent:split, posts no comment, and the next tick closes the parent", () => {
  const issues = [{ number: FAILS.parent, labels: SPLIT }];
  const subs = [sub(FAILS.sub, "closed", "completed")];
  const refused = {
    when: `issue close ${FAILS.parent}`,
    code: 1,
    stderr: "HTTP 403: Resource not accessible by integration",
  };
  const failed = tickOver(issues, [subsOf(FAILS.parent, subs), refused]);
  assert.deepEqual(
    failed.parents.map(({ issue, outcome }) => ({ issue, outcome })),
    [{ issue: FAILS.parent, outcome: "failed" }],
  );
  assert.ok(
    !failed.effects.includes(`comment #${FAILS.parent} role=coordinator`),
  );
  const [escalation, ...more] = linesOf("escalations.jsonl", FAILS.parent);
  assert.deepEqual(more, []);
  assert.equal(escalation?.label, "agent:split");
  assert.ok(escalation?.reason.startsWith("close-parent failed"));
  const logged = linesOf("orchestrator.log", FAILS.parent);
  assert.deepEqual(
    logged.map(({ action, reason }) => ({ action, reason })),
    [{ action: "escalated", reason: escalation?.reason }],
  );
  const retried = tickOver(issues, [subsOf(FAILS.parent, subs)]);
  assert.deepEqual(retried.parents, [
    { issue: FAILS.parent, outcome: "closed" },
  ]);
  assert.ok(retried.effects.includes(`issue close ${FAILS.parent} -R o/r`));
});

test("a parent another sweep reserved lately is left alone, with no read of its sub-issues", () => {
  const file = runFile("reservations.json");
  /** @type {Record<string, unknown>} */
  let held = {};
  if (fs.existsSync(file)) {
    held = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(fs.readFileSync(file, "utf8")));
  }
  const theirs = { sweepId: "other", at: NOW.toISOString() };
  fs.writeFileSync(
    file,
    JSON.stringify({ ...held, [`parent-${RESERVED.parent}`]: theirs }),
  );
  const { parents } = tickOver(
    [{ number: RESERVED.parent, labels: SPLIT }],
    [],
  );
  assert.deepEqual(parents, [{ issue: RESERVED.parent, outcome: "reserved" }]);
  const read = fakeGh
    .calls()
    .some((args) =>
      args.join(" ").includes(`issues/${RESERVED.parent}/sub_issues`),
    );
  assert.equal(read, false);
});

test("nested parents close bottom-up, one level a tick", () => {
  const issues = [
    { number: NESTED.outer, labels: SPLIT },
    { number: NESTED.inner, labels: SPLIT },
  ];
  const first = tickOver(issues, [
    subsOf(NESTED.outer, [sub(NESTED.inner, "open", null, SPLIT)]),
    subsOf(NESTED.inner, [sub(NESTED.leaf, "closed", "completed")]),
  ]);
  assert.deepEqual(
    first.parents.map(({ issue, outcome }) => ({ issue, outcome })),
    [
      { issue: NESTED.outer, outcome: "waiting" },
      { issue: NESTED.inner, outcome: "closed" },
    ],
  );
  const merged = ["agent:merged"];
  const second = tickOver(
    [{ number: NESTED.outer, labels: SPLIT }],
    [subsOf(NESTED.outer, [sub(NESTED.inner, "closed", "completed", merged)])],
  );
  assert.deepEqual(second.parents, [
    { issue: NESTED.outer, outcome: "closed" },
  ]);
  assert.equal(closedLines(NESTED.outer), 1);
});
