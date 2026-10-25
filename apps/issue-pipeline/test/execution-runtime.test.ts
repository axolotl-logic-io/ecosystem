import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { executionFixture } from "./execution-runtime-test-kit.ts";

const { assertExecution }: typeof import("../src/execution.ts") = await import(
  "../src/execution.ts"
);
const {
  claimExecutionState,
  readExecutionClaimState,
  saveExecutionState,
}: typeof import("../src/execution-state.ts") = await import(
  "../src/execution-state.ts"
);
const { stateBody }: typeof import("../src/saved-state.ts") = await import(
  "../src/saved-state.ts"
);
const FRESH = 401;
const LAPSED = 402;
const UNKNOWN = 403;
const LOST = 404;
const RELEASED = 405;
const UNBOUND = 406;
const MISMATCH = 407;
const ABSENT = 410;
const HELD = /reconcil|execution|ownership|authority|binding|provenance/u;
const STATE = /agent-pipeline:state/u;

function stateWrites(fixture: ReturnType<typeof executionFixture>): string[][] {
  return fixture.writes().filter((args) => args.some((arg) => STATE.test(arg)));
}

test("fresh explicit claim checkpoints a confirmed receipt before caller setup", () => {
  const fixture = executionFixture(FRESH);
  assert.equal(fixture.read(), null);
  const state = fixture.claim();
  fixture.setup();
  assert.equal(fixture.setupExists(), true);
  assert.equal(state.execution?.instance, fixture.cfg.execution?.instance);
  assert.equal(state.branch, fixture.cfg.execution?.branch);
  const history = fixture.guard().read();
  assert.equal(history.confirmed, true);
  assert.equal(history.owner?.id, state.execution?.request);
  assert.equal(fixture.read()?.execution?.request, history.owner?.id);
  assert.equal(stateWrites(fixture).length, 1);
  assert.ok(fixture.calls().every((call) => call.identity === "merge"));
});

test("unreleased historical ownership refuses the same lane despite a lapsed diagnostic lease", () => {
  const fixture = executionFixture(LAPSED);
  const state = fixture.claim();
  fixture.save({
    ...state,
    lease: { lane: "stable", sweepId: "old", at: "2000-01-01T00:00:00Z" },
  });
  const next = fixture.next();
  const before = fixture.transport();
  assert.throws(() => claimExecutionState(next, fixture.issue), HELD);
  assert.deepEqual(fixture.transport(), before);
  assert.equal(fixture.setupExists(), false);
});

test("unresolved save retains exact intent and bars writer assertion, retry and release", () => {
  const fixture = executionFixture(UNKNOWN);
  const state = fixture.claim();
  const next = { ...state, stopCode: "uncertain-checkpoint" };
  fixture.update((transport) => {
    transport.failState = true;
  });
  const beforeWrites = stateWrites(fixture).length;
  assert.throws(() => fixture.save(next), HELD);
  assert.equal(stateWrites(fixture).length, beforeWrites + 1);
  const intent = fs.readFileSync(fixture.journal, "utf8");
  assert.equal(
    JSON.parse(intent).evidence.body,
    stateBody(fixture.issue, next),
  );
  assert.deepEqual(JSON.parse(intent).evidence.execution, state.execution);
  const before = fixture.transport();
  const writes = fixture.writes();
  assert.throws(() => assertExecution(fixture.cfg, fixture.issue), HELD);
  assert.throws(() => fixture.save(next), HELD);
  assert.throws(() => fixture.guard().release(), HELD);
  assert.throws(() => fixture.claim(), HELD);
  assert.deepEqual(fixture.transport(), before);
  assert.deepEqual(fixture.writes(), writes);
  assert.equal(fs.readFileSync(fixture.journal, "utf8"), intent);
});

test("exact authenticated read-back resolves a lost response with one save attempt", () => {
  const fixture = executionFixture(LOST);
  const state = fixture.claim();
  fixture.update((transport) => {
    transport.loseStateResponse = true;
  });
  const before = stateWrites(fixture).length;
  const saved = fixture.save({ ...state, stopCode: "response-lost" });
  assert.equal(saved.stopCode, "response-lost");
  assert.equal(stateWrites(fixture).length, before + 1);
  assert.equal(fs.existsSync(fixture.journal), false);
  assertExecution(fixture.cfg, fixture.issue);
});

for (const [offset, readback] of [
  { graphBody: "stale-state" },
  { graphAuthor: { login: "visitor" } },
  { lastEditedAt: "2026-10-21T00:00:00Z", editor: { login: "visitor" } },
].entries()) {
  test(`a successful save response cannot override mismatched same-read evidence: ${offset}`, () => {
    const fixture = executionFixture(MISMATCH + offset);
    const state = fixture.claim();
    const intended = { ...state, stopCode: "needs-confirmation" };
    fixture.update((transport) => {
      transport.stateReadback = readback;
      if (readback.graphBody !== undefined) {
        transport.stateReadback = {
          graphBody: stateBody(fixture.issue, state),
        };
      }
    });
    const before = stateWrites(fixture).length;
    assert.throws(() => fixture.save(intended), HELD);
    assert.equal(stateWrites(fixture).length, before + 1);
    const intent = fs.readFileSync(fixture.journal, "utf8");
    assert.equal(
      JSON.parse(intent).evidence.body,
      stateBody(fixture.issue, intended),
    );
    const writes = fixture.writes();
    assert.throws(() => assertExecution(fixture.cfg, fixture.issue), HELD);
    assert.throws(() => fixture.save(intended), HELD);
    assert.throws(() => fixture.guard().release(), HELD);
    assert.deepEqual(fixture.writes(), writes);
    assert.equal(fs.readFileSync(fixture.journal, "utf8"), intent);
  });
}

test("missing state beside authenticated execution history cannot initialize new work", () => {
  const fixture = executionFixture(ABSENT);
  fixture.claim();
  fixture.update((transport) => {
    transport.comments = transport.comments.filter(
      (comment) => !STATE.test(comment.body),
    );
  });
  const before = fixture.writes();
  // A later invocation finds another run's history without its state. The
  // claiming invocation's own records alone are a first claim's (#167).
  const next = fixture.next();
  assert.throws(() => readExecutionClaimState(next, fixture.issue), HELD);
  assert.throws(() => claimExecutionState(next, fixture.issue), HELD);
  assert.deepEqual(fixture.writes(), before);
});

test("released authenticated history permits a new receipt, never current ownership by itself", () => {
  const fixture = executionFixture(RELEASED);
  const state = fixture.claim();
  fixture.guard().release();
  const next = fixture.next();
  const inspected = readExecutionClaimState(next, fixture.issue);
  assert.deepEqual(inspected, state);
  assert.throws(() => saveExecutionState(next, fixture.issue, state), HELD);
  const claimed = claimExecutionState(next, fixture.issue);
  assert.notDeepEqual(claimed.execution, state.execution);
  assert.equal(claimed.branch, state.branch);
});

for (const operation of [readExecutionClaimState, claimExecutionState]) {
  test(`the explicit seam refuses an unbound caller: ${operation.name}`, () => {
    const fixture = executionFixture(UNBOUND);
    const {
      execution: _execution,
      mutation: _mutation,
      ...unbound
    } = fixture.cfg;
    fixture.claim();
    const before = fixture.writes();
    assert.throws(() => operation(unbound, fixture.issue));
    assert.deepEqual(fixture.writes(), before);
  });
}

test("the explicit save refuses an unbound caller", () => {
  const fixture = executionFixture(UNBOUND);
  const {
    execution: _execution,
    mutation: _mutation,
    ...unbound
  } = fixture.cfg;
  const state = fixture.claim();
  const before = fixture.writes();
  assert.throws(() => saveExecutionState(unbound, fixture.issue, state));
  assert.deepEqual(fixture.writes(), before);
});
