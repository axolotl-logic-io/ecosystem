// @ts-check
// Where locate starts the implementor (#414, `every-role-resumes`): always at
// the shared `start`, with the checkpoints and hand-off fields read back. A
// state saved by today's implement stage (its `continuations` a number or a
// per-stage record, its phase `decide`) resumes with its count, read through
// stages/continuation.ts; the role's own checkpoint wins once it has one.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HANDOFF,
  ISSUE,
  implContext,
  located,
  outOfRoom,
  SPEC,
  stepFrom,
} from "./implementor-role-test-kit.mjs";

/** @import { State } from "../src/state.ts" */

// Saved counts, and a config limit, unlike the defaults.
const COUNTS = { fixRounds: 2, conflictFixes: 1, ciFixRounds: 3 };
const MAX = 2;
// The PR the kit's saved state names.
const PR = 42;

test("locate starts every implement run at start, with the implement entry", () => {
  for (const saved of [
    {},
    { phase: "decide" },
    { specTestsSha: "s1", headSha: "h9" },
    { implemented: true },
  ]) {
    const { at, data } = located(saved);
    assert.equal(at, "start", JSON.stringify(saved));
    assert.equal(data.entry, "implement");
  }
});

test("an old state's continuation count is kept, as a number or a per-stage record", () => {
  /** @type {[State, number][]} */
  const cases = [
    [{ continuations: 1, phase: "decide" }, 1],
    [{ continuations: { implement: 1, fix: 2 }, phase: "decide" }, 1],
    [{ continuations: { fix: 1 } }, 0],
    [{ continuations: {} }, 0],
    [{}, 0],
  ];
  for (const [saved, count] of cases) {
    const { data } = located(saved);
    assert.equal(data.continuations, count, JSON.stringify(saved));
  }
});

test("the role's continuations checkpoint wins over the old field", () => {
  const ahead = located({
    checkpoints: { continuations: 1 },
    continuations: {},
  });
  assert.equal(ahead.data.continuations, 1);
  const behind = located({
    checkpoints: { continuations: 0 },
    continuations: { implement: 1 },
  });
  assert.equal(behind.data.continuations, 0);
});

test("the other counts come from the checkpoints, and the limit from the config", () => {
  const { data } = located(
    { checkpoints: COUNTS },
    implContext({ maxContinuations: MAX }),
  );
  assert.equal(data.fixRounds, COUNTS.fixRounds);
  assert.equal(data.conflictFixes, COUNTS.conflictFixes);
  assert.equal(data.ciFixRounds, COUNTS.ciFixRounds);
  assert.equal(data.maxContinuations, MAX);
  const fresh = located().data;
  assert.equal(fresh.fixRounds, 0);
  assert.equal(fresh.conflictFixes, 0);
  assert.equal(fresh.ciFixRounds, 0);
});

test("locate reads back the spec writer's hand-off and the reviewer's fields", () => {
  const findings = [{ id: "f1", status: "open" }];
  const { data } = located({
    specTestsSha: "s1",
    wikiOnly: false,
    noTestsReason: null,
    findings,
    verifiedSha: "v1",
  });
  assert.equal(data.issue, ISSUE);
  assert.equal(data.spec, SPEC);
  assert.equal(data.pr, PR);
  assert.equal(data.headSha, "aaaaaaa");
  assert.equal(data.specTestsSha, "s1");
  assert.equal(data.wikiOnly, false);
  assert.deepEqual(data.findings, findings);
  assert.equal(data.verifiedSha, "v1");
  assert.equal(data.reply, null);
  const bare = located({ pr: null }).data;
  assert.equal(bare.pr, null);
  assert.deepEqual(bare.findings, []);
  assert.equal(bare.verifiedSha, null);
});

test("an old state at its last continuation stops as too large on its next handoff", () => {
  const { data } = located({ continuations: 1, phase: "decide" });
  const step = stepFrom("implementer-reply", "handoff", null, {
    ...data,
    reply: HANDOFF,
  });
  assert.equal(step.state.at, "out-of-room");
  assert.deepEqual(step.effect, {
    kind: "end",
    end: outOfRoom(1, HANDOFF.summary),
  });
});
